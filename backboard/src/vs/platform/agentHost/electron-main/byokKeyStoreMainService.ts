/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { IEncryptionMainService } from '../../encryption/common/encryptionService.js';
import { ILogService } from '../../log/common/log.js';
import { readEncryptedSecret, secretStorageKey, writeEncryptedSecret } from '../../secrets/common/secrets.js';
import { StorageScope, StorageTarget } from '../../storage/common/storage.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { IAgentCommandResult } from '../common/agentService.js';
import { ByokKeyOperationOutcome, IByokKeyStatus, IByokKeyStore, maskKey } from '../common/byokKeyStore.js';
import { BYOK_COMMANDS, BYOK_GENERATION_ARG, BYOK_KEY_ARG, BYOK_PROVIDER_ARG, BYOK_PROVIDERS, ByokProviderId, byokProviderDefinition } from '../common/byokProviders.js';
import { IAgentHostProcessAccess } from '../node/agentHostService.js';

/** Secret storage key for one provider's API key; the same key the renderer wrote before main owned the store. */
const SECRET_KEY_PREFIX = 'backboard.byok.';
/** Application-scoped, non-secret record describing a stored key. */
const META_KEY_PREFIX = 'backboard.byok.meta.';
/** The agent provider that owns the key commands. */
const BACKBOARD_AGENT_PROVIDER = 'backboard';
/** Upper bound on one agent-host command, so a hung host cannot wedge the page. */
const HOST_COMMAND_TIMEOUT_MS = 30_000;

type Persistence = 'persisted' | 'in-memory';

/** Non-secret facts about a stored key. Never contains the key itself. */
interface IByokKeyRecord {
	readonly masked: string;
	readonly addedAt: number;
	readonly lastValidatedAt?: number;
	readonly lastError?: string;
	readonly lastErrorCategory?: string;
}

type HostCall =
	| { readonly ok: true; readonly result: IAgentCommandResult }
	| { readonly ok: false; readonly message: string; readonly unavailable: boolean };

/** Thrown inside a write when a newer change for the provider arrived first. */
class SupersededError extends Error {
	constructor() {
		super('superseded');
	}
}

function failure(message: string, category: string): ByokKeyOperationOutcome {
	return { ok: false, message, category };
}

function superseded(label: string): ByokKeyOperationOutcome {
	return failure(localize('byokKeyStore.superseded', "A newer change to the {0} key replaced this one.", label), 'superseded');
}

/**
 * The main-process owner of provider API keys. Every mutation reserves a
 * per-provider generation; an operation whose generation is no longer the
 * newest changes nothing, however late its validation or activation lands,
 * and the agent host rejects stale generations too. Keys are stored the way
 * the renderer's secret storage stored them (encrypted `secret://` entries in
 * application storage), so keys added before this owner existed carry over.
 */
export class ByokKeyStoreMainService extends Disposable implements IByokKeyStore {

	private readonly _onDidChange = this._register(new Emitter<readonly IByokKeyStatus[]>());
	readonly onDidChange = this._onDidChange.event;

	/** The newest generation reserved per provider; 0 means "the key found at startup". */
	private readonly _generations = new Map<ByokProviderId, number>();
	private _nextGeneration = 1;
	/** Whether the agent host holds each stored key, from its latest acknowledgement. */
	private readonly _connected = new Map<ByokProviderId, boolean>();
	/** Keys and records held only in memory while OS encryption is unavailable. */
	private readonly _memoryKeys = new Map<ByokProviderId, string>();
	private readonly _memoryRecords = new Map<ByokProviderId, IByokKeyRecord>();
	private _mode: Persistence | undefined;
	private _ready: Promise<Persistence> | undefined;

	constructor(
		private readonly _agentHost: IAgentHostProcessAccess,
		@IApplicationStorageMainService private readonly _storage: IApplicationStorageMainService,
		@IEncryptionMainService private readonly _encryption: IEncryptionMainService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		// A (re)started agent host holds nothing: hand it every stored key. The
		// host is started before this store exists, so a host that is already
		// up gets the same treatment right away instead of at its next restart.
		this._register(this._agentHost.onDidStart(() => this._pushAllToHostSafely()));
		if (this._agentHost.agentService) {
			this._pushAllToHostSafely();
		}
	}

	private _pushAllToHostSafely(): void {
		this._pushAllToHost().catch(error => this._logService.warn(`[byok] could not hand stored keys to the agent host: ${toMessage(error)}`));
	}

	async list(): Promise<readonly IByokKeyStatus[]> {
		await this._whenReady();
		return this._statuses();
	}

	async add(provider: ByokProviderId, key: string): Promise<ByokKeyOperationOutcome> {
		await this._whenReady();
		const label = byokProviderDefinition(provider).label;
		const trimmed = key.trim();
		if (!trimmed) {
			return failure(localize('byokKeyStore.empty', "Enter a {0} API key.", label), 'invalid-key');
		}
		const generation = this._reserve(provider);
		// 1. Validate in the runtime; nothing is stored for a rejected key.
		const validation = await this._validate(provider, trimmed);
		if (!validation.ok) {
			return validation;
		}
		// 2. Persist, unless a newer change for this provider arrived meanwhile.
		if (!this._isNewest(provider, generation)) {
			return superseded(label);
		}
		const now = Date.now();
		try {
			await this._writeKey(provider, trimmed, { masked: maskKey(trimmed), addedAt: now, lastValidatedAt: now }, generation);
		} catch (error) {
			if (error instanceof SupersededError) {
				return superseded(label);
			}
			// The previous key, if any, is untouched and stays active.
			this._logService.error(`[byok] ${provider} key could not be saved: ${toMessage(error)}`);
			return failure(localize('byokKeyStore.persistFailed', "The {0} key could not be saved: {1}", label, toMessage(error)), 'storage');
		}
		this._connected.delete(provider);
		this._fireChange();
		// 3. Activate. A failure here leaves the key "saved, connection pending".
		await this._activate(provider, trimmed, generation);
		return { ok: true };
	}

	async remove(provider: ByokProviderId): Promise<ByokKeyOperationOutcome> {
		await this._whenReady();
		const generation = this._reserve(provider);
		// Stored state goes first, synchronously: nothing that reserved an older
		// generation can write after this point.
		this._deleteKey(provider);
		this._connected.delete(provider);
		this._fireChange();
		const call = await this._hostCommand(BYOK_COMMANDS.remove, { [BYOK_PROVIDER_ARG]: provider, [BYOK_GENERATION_ARG]: generation });
		if (!call.ok && !call.unavailable) {
			// The key is gone from the store; only the runtime could not confirm dropping it.
			return failure(call.message, 'runtime');
		}
		return { ok: true };
	}

	async test(provider: ByokProviderId): Promise<ByokKeyOperationOutcome> {
		await this._whenReady();
		const label = byokProviderDefinition(provider).label;
		const generation = this._current(provider);
		const key = await this._readKey(provider);
		const record = this._readRecord(provider);
		if (!key || !record) {
			return failure(localize('byokKeyStore.notSet', "No {0} API key is stored.", label), 'invalid-key');
		}
		const validation = await this._validate(provider, key);
		if (!this._isNewest(provider, generation)) {
			// The key changed while it was being tested; the result describes a key that no longer exists.
			return superseded(label);
		}
		this._writeRecord(provider, validation.ok
			? { ...record, lastValidatedAt: Date.now(), lastError: undefined, lastErrorCategory: undefined }
			: { ...record, lastError: validation.message, lastErrorCategory: validation.category });
		this._fireChange();
		return validation;
	}

	// ---- generations ---------------------------------------------------------

	private _reserve(provider: ByokProviderId): number {
		const generation = this._nextGeneration++;
		this._generations.set(provider, generation);
		return generation;
	}

	private _current(provider: ByokProviderId): number {
		return this._generations.get(provider) ?? 0;
	}

	private _isNewest(provider: ByokProviderId, generation: number): boolean {
		return this._current(provider) === generation;
	}

	// ---- agent host ----------------------------------------------------------

	private async _validate(provider: ByokProviderId, key: string): Promise<ByokKeyOperationOutcome> {
		const label = byokProviderDefinition(provider).label;
		const call = await this._hostCommand(BYOK_COMMANDS.validate, { [BYOK_PROVIDER_ARG]: provider, [BYOK_KEY_ARG]: key });
		if (!call.ok) {
			return failure(call.message, 'offline-or-timeout');
		}
		if (call.result.data?.ok !== true) {
			const category = typeof call.result.data?.category === 'string' ? call.result.data.category : 'provider-error';
			return failure(call.result.message || localize('byokKeyStore.rejected', "{0} could not verify this key.", label), category);
		}
		return { ok: true };
	}

	private async _activate(provider: ByokProviderId, key: string, generation: number): Promise<void> {
		if (!this._isNewest(provider, generation)) {
			return;
		}
		const call = await this._hostCommand(BYOK_COMMANDS.set, { [BYOK_PROVIDER_ARG]: provider, [BYOK_KEY_ARG]: key, [BYOK_GENERATION_ARG]: generation });
		if (!this._isNewest(provider, generation)) {
			return;
		}
		if (call.ok) {
			this._connected.set(provider, call.result.data?.connected !== false);
		} else {
			this._logService.warn(`[byok] ${provider} key saved but not activated: ${call.message}`);
			this._connected.set(provider, false);
		}
		this._fireChange();
	}

	/** Hands every stored key to a freshly started agent host, under the generation each currently has. */
	private async _pushAllToHost(): Promise<void> {
		await this._whenReady();
		this._connected.clear();
		this._fireChange();
		for (const definition of BYOK_PROVIDERS) {
			const provider = definition.id;
			const generation = this._current(provider);
			let key: string | undefined;
			try {
				key = await this._readKey(provider);
			} catch (error) {
				this._logService.warn(`[byok] could not read the stored ${provider} key: ${toMessage(error)}`);
				continue;
			}
			if (!key || !this._isNewest(provider, generation)) {
				continue;
			}
			const call = await this._hostCommand(BYOK_COMMANDS.set, { [BYOK_PROVIDER_ARG]: provider, [BYOK_KEY_ARG]: key, [BYOK_GENERATION_ARG]: generation });
			if (!this._isNewest(provider, generation)) {
				continue;
			}
			this._connected.set(provider, call.ok && call.result.data?.connected !== false);
		}
		this._fireChange();
	}

	private async _hostCommand(command: string, args: Record<string, unknown>): Promise<HostCall> {
		const agentService = this._agentHost.agentService;
		if (!agentService?.executeAgentCommand) {
			return { ok: false, unavailable: true, message: localize('byokKeyStore.hostNotRunning', "The Backboard agent host is not running.") };
		}
		try {
			const result = await raceTimeout(agentService.executeAgentCommand({ provider: BACKBOARD_AGENT_PROVIDER, command, args }), HOST_COMMAND_TIMEOUT_MS);
			if (!result) {
				return { ok: false, unavailable: false, message: localize('byokKeyStore.hostTimeout', "The Backboard agent host did not respond in time.") };
			}
			return { ok: true, result };
		} catch (error) {
			return { ok: false, unavailable: false, message: toMessage(error) };
		}
	}

	// ---- storage -------------------------------------------------------------

	private _whenReady(): Promise<Persistence> {
		this._ready ??= (async () => {
			await this._storage.whenReady;
			let available = false;
			try {
				available = await this._encryption.isEncryptionAvailable();
			} catch (error) {
				this._logService.warn(`[byok] could not determine encryption availability: ${toMessage(error)}`);
			}
			if (!available) {
				this._logService.warn('[byok] OS encryption is unavailable; provider keys are kept in memory for this session only.');
			}
			this._mode = available ? 'persisted' : 'in-memory';
			return this._mode;
		})();
		return this._ready;
	}

	private async _readKey(provider: ByokProviderId): Promise<string | undefined> {
		if (this._mode !== 'persisted') {
			return this._memoryKeys.get(provider);
		}
		return readEncryptedSecret(
			SECRET_KEY_PREFIX + provider,
			fullKey => this._storage.get(fullKey, StorageScope.APPLICATION),
			value => this._encryption.decrypt(value),
			this._logService,
		);
	}

	private async _writeKey(provider: ByokProviderId, key: string, record: IByokKeyRecord, generation: number): Promise<void> {
		if (this._mode === 'persisted') {
			await writeEncryptedSecret(
				SECRET_KEY_PREFIX + provider,
				key,
				(fullKey, encrypted) => {
					// Checked right before the synchronous write: nothing can slip in between.
					if (!this._isNewest(provider, generation)) {
						throw new SupersededError();
					}
					this._storage.store(fullKey, encrypted, StorageScope.APPLICATION, StorageTarget.MACHINE);
				},
				value => this._encryption.encrypt(value),
				this._logService,
			);
		} else {
			if (!this._isNewest(provider, generation)) {
				throw new SupersededError();
			}
			this._memoryKeys.set(provider, key);
		}
		this._writeRecord(provider, record);
	}

	private _deleteKey(provider: ByokProviderId): void {
		if (this._mode === 'persisted') {
			this._storage.remove(secretStorageKey(SECRET_KEY_PREFIX + provider), StorageScope.APPLICATION);
			this._storage.remove(META_KEY_PREFIX + provider, StorageScope.APPLICATION);
		}
		this._memoryKeys.delete(provider);
		this._memoryRecords.delete(provider);
	}

	private _readRecord(provider: ByokProviderId): IByokKeyRecord | undefined {
		if (this._mode !== 'persisted') {
			return this._memoryRecords.get(provider);
		}
		const raw = this._storage.get(META_KEY_PREFIX + provider, StorageScope.APPLICATION);
		if (!raw) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(raw) as Partial<IByokKeyRecord>;
			if (typeof parsed.masked !== 'string' || typeof parsed.addedAt !== 'number') {
				return undefined;
			}
			return {
				masked: parsed.masked,
				addedAt: parsed.addedAt,
				...(typeof parsed.lastValidatedAt === 'number' ? { lastValidatedAt: parsed.lastValidatedAt } : {}),
				...(typeof parsed.lastError === 'string' ? { lastError: parsed.lastError } : {}),
				...(typeof parsed.lastErrorCategory === 'string' ? { lastErrorCategory: parsed.lastErrorCategory } : {}),
			};
		} catch {
			return undefined;
		}
	}

	private _writeRecord(provider: ByokProviderId, record: IByokKeyRecord): void {
		if (this._mode === 'persisted') {
			this._storage.store(META_KEY_PREFIX + provider, JSON.stringify(record), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} else {
			this._memoryRecords.set(provider, record);
		}
	}

	private _statuses(): readonly IByokKeyStatus[] {
		const persistence = this._mode ?? 'unknown';
		return BYOK_PROVIDERS.map(definition => {
			const record = this._readRecord(definition.id);
			return {
				provider: definition.id,
				label: definition.label,
				keyHint: definition.keyHint,
				consoleUrl: definition.consoleUrl,
				configured: !!record,
				masked: record?.masked,
				addedAt: record?.addedAt,
				lastValidatedAt: record?.lastValidatedAt,
				lastError: record?.lastError,
				lastErrorCategory: record?.lastErrorCategory,
				connected: this._connected.get(definition.id) === true,
				persistence,
			};
		});
	}

	private _fireChange(): void {
		this._onDidChange.fire(this._statuses());
	}
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
