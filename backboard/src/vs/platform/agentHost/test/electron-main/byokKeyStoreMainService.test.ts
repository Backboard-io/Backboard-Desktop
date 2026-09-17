/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IEncryptionMainService } from '../../../encryption/common/encryptionService.js';
import { NullLogService } from '../../../log/common/log.js';
import { StorageScope, StorageTarget } from '../../../storage/common/storage.js';
import { IApplicationStorageMainService } from '../../../storage/electron-main/storageMainService.js';
import { IAgentCommandParams, IAgentCommandResult, IAgentService } from '../../common/agentService.js';
import { ByokKeyStoreMainService } from '../../electron-main/byokKeyStoreMainService.js';
import { IAgentHostProcessAccess } from '../../node/agentHostService.js';

const KEY_1 = 'sk-test-first-1234567890';
const KEY_2 = 'sk-test-second-1234567890';
const SECRET_KEY = 'secret://backboard.byok.openai';

interface IRecordedCommand {
	readonly command: string;
	readonly key: unknown;
	readonly generation: unknown;
}

class TestStorage {
	readonly items = new Map<string, string>();
	readonly whenReady = Promise.resolve();
	failNextStore = false;

	get(key: string, _scope: StorageScope, fallback?: string): string | undefined {
		return this.items.get(key) ?? fallback;
	}

	store(key: string, value: string | boolean | number | undefined | null, _scope: StorageScope, _target: StorageTarget): void {
		if (this.failNextStore) {
			this.failNextStore = false;
			throw new Error('disk full');
		}
		this.items.set(key, String(value));
	}

	remove(key: string, _scope: StorageScope): void {
		this.items.delete(key);
	}

	asService(): IApplicationStorageMainService {
		return this as unknown as IApplicationStorageMainService;
	}
}

class TestEncryption {
	constructor(private readonly _available: boolean) { }

	async encrypt(value: string): Promise<string> {
		return `enc:${value}`;
	}

	async decrypt(value: string): Promise<string> {
		return value.replace(/^enc:/, '');
	}

	async isEncryptionAvailable(): Promise<boolean> {
		return this._available;
	}

	asService(): IEncryptionMainService {
		return this as unknown as IEncryptionMainService;
	}
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error('condition not met in time');
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

suite('ByokKeyStoreMainService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createFixture(options: { encryptionAvailable?: boolean; hostRunning?: boolean; storedKeys?: Record<string, string> } = {}) {
		const commands: IRecordedCommand[] = [];
		const handlers = new Map<string, (params: IAgentCommandParams) => Promise<IAgentCommandResult>>();
		const hostStart = store.add(new Emitter<void>());
		const agentService = {
			executeAgentCommand: async (params: IAgentCommandParams) => {
				commands.push({ command: params.command, key: params.args?.key, generation: params.args?.generation });
				const handler = handlers.get(params.command);
				return handler ? handler(params) : { message: 'ok', data: { ok: true, connected: true } };
			},
		} as Partial<IAgentService> as IAgentService;
		const host: { onDidStart: IAgentHostProcessAccess['onDidStart']; agentService: IAgentService | undefined } = { onDidStart: hostStart.event, agentService: options.hostRunning === false ? undefined : agentService };
		const storage = new TestStorage();
		for (const [provider, key] of Object.entries(options.storedKeys ?? {})) {
			storage.items.set(`secret://backboard.byok.${provider}`, `enc:${key}`);
			storage.items.set(`backboard.byok.meta.${provider}`, JSON.stringify({ masked: 'sk-test…7890', addedAt: 1 }));
		}
		const service = store.add(new ByokKeyStoreMainService(host, storage.asService(), new TestEncryption(options.encryptionAvailable ?? true).asService(), new NullLogService()));
		const openai = async () => (await service.list()).find(status => status.provider === 'openai')!;
		return { service, storage, commands, handlers, hostStart, host, openai };
	}

	test('validates, persists, then activates a key', async () => {
		const { service, storage, commands, openai } = createFixture();

		const outcome = await service.add('openai', ` ${KEY_1} `);

		const status = await openai();
		assert.deepStrictEqual({
			outcome,
			commands,
			// The secret is trimmed, encrypted, and stored where the renderer used to store it.
			stored: storage.items.get(SECRET_KEY),
			status: { configured: status.configured, connected: status.connected, masked: status.masked, persistence: status.persistence },
		}, {
			outcome: { ok: true },
			commands: [{ command: 'providerKeys.validate', key: KEY_1, generation: undefined }, { command: 'providerKeys.set', key: KEY_1, generation: 1 }],
			stored: `enc:${KEY_1}`,
			status: { configured: true, connected: true, masked: 'sk-test…7890', persistence: 'persisted' },
		});
	});

	test('a removal wins over an earlier replacement that finishes later', async () => {
		const { service, storage, commands, handlers, openai } = createFixture();
		await service.add('openai', KEY_1);
		const slowValidation = new DeferredPromise<IAgentCommandResult>();
		handlers.set('providerKeys.validate', params => params.args?.key === KEY_2 ? slowValidation.p : Promise.resolve({ message: 'ok', data: { ok: true } }));

		const replacement = service.add('openai', KEY_2);
		const removal = await service.remove('openai');
		slowValidation.complete({ message: 'ok', data: { ok: true } });
		const replaced = await replacement;

		assert.deepStrictEqual({
			removal,
			replaced,
			stored: storage.items.get(SECRET_KEY),
			configured: (await openai()).configured,
			activations: commands.filter(command => command.command === 'providerKeys.set').map(command => command.key),
			removalGeneration: commands.find(command => command.command === 'providerKeys.remove')?.generation,
		}, {
			removal: { ok: true },
			// The late validation result is dropped: nothing is stored or activated for it.
			replaced: { ok: false, message: 'A newer change to the OpenAI key replaced this one.', category: 'superseded' },
			stored: undefined,
			configured: false,
			activations: [KEY_1],
			removalGeneration: 3,
		});
	});

	test('competing replacements: the latest reservation wins whatever the order of results', async () => {
		const { service, storage, commands, handlers } = createFixture();
		const validations = new Map<string, DeferredPromise<IAgentCommandResult>>([[KEY_1, new DeferredPromise()], [KEY_2, new DeferredPromise()]]);
		handlers.set('providerKeys.validate', params => validations.get(String(params.args?.key))!.p);

		const first = service.add('openai', KEY_1);
		const second = service.add('openai', KEY_2);
		validations.get(KEY_1)!.complete({ message: 'ok', data: { ok: true } });
		validations.get(KEY_2)!.complete({ message: 'ok', data: { ok: true } });

		assert.deepStrictEqual({
			first: (await first).ok,
			second: (await second).ok,
			stored: storage.items.get(SECRET_KEY),
			activations: commands.filter(command => command.command === 'providerKeys.set').map(command => [command.key, command.generation]),
		}, {
			first: false,
			second: true,
			stored: `enc:${KEY_2}`,
			activations: [[KEY_2, 2]],
		});
	});

	test('a test result for a key that was replaced meanwhile is discarded', async () => {
		const { service, handlers, openai } = createFixture();
		await service.add('openai', KEY_1);
		const slowValidation = new DeferredPromise<IAgentCommandResult>();
		handlers.set('providerKeys.validate', params => params.args?.key === KEY_1 ? slowValidation.p : Promise.resolve({ message: 'ok', data: { ok: true } }));

		const test = service.test('openai');
		await service.add('openai', KEY_2);
		slowValidation.complete({ message: 'OpenAI rejected that key.', data: { ok: false, category: 'invalid-key' } });
		const outcome = await test;

		const status = await openai();
		assert.deepStrictEqual({ category: outcome.ok ? undefined : outcome.category, lastError: status.lastError, masked: status.masked }, {
			category: 'superseded',
			// The rejection concerned the old key and never reaches the record of the new one.
			lastError: undefined,
			masked: 'sk-test…7890',
		});
	});

	test('a persistence failure keeps the previous key stored and active', async () => {
		const { service, storage, commands, openai } = createFixture();
		await service.add('openai', KEY_1);
		storage.failNextStore = true;

		const outcome = await service.add('openai', KEY_2);

		assert.deepStrictEqual({
			category: outcome.ok ? undefined : outcome.category,
			stored: storage.items.get(SECRET_KEY),
			connected: (await openai()).connected,
			activations: commands.filter(command => command.command === 'providerKeys.set').map(command => command.key),
		}, {
			category: 'storage',
			stored: `enc:${KEY_1}`,
			connected: true,
			activations: [KEY_1],
		});
	});

	test('an activation failure reports the key as saved with the connection pending', async () => {
		const { service, storage, handlers, openai } = createFixture();
		handlers.set('providerKeys.set', async () => { throw new Error('agent host unavailable'); });

		const outcome = await service.add('openai', KEY_1);

		const status = await openai();
		assert.deepStrictEqual(
			{ outcome, stored: !!storage.items.get(SECRET_KEY), configured: status.configured, connected: status.connected },
			{ outcome: { ok: true }, stored: true, configured: true, connected: false },
		);
	});

	test('hands every stored key to a restarted agent host under its current generation', async () => {
		const { service, commands, hostStart, openai } = createFixture();
		await service.add('openai', KEY_1);
		const beforeRestart = commands.length;

		hostStart.fire();
		await until(() => commands.length > beforeRestart);
		await until(() => commands.length === beforeRestart + 1);

		assert.deepStrictEqual({ pushed: commands.slice(beforeRestart), connected: (await openai()).connected }, {
			pushed: [{ command: 'providerKeys.set', key: KEY_1, generation: 1 }],
			connected: true,
		});
	});

	test('hands keys stored by an earlier run to a host that was already running when the store started', async () => {
		const { commands, openai } = createFixture({ storedKeys: { openai: KEY_1 } });

		await until(() => commands.length === 1);

		assert.deepStrictEqual({ commands, status: await openai().then(status => [status.configured, status.connected, status.masked]) }, {
			// Generation 0 marks "the key found at startup"; any later change reserves a newer one.
			commands: [{ command: 'providerKeys.set', key: KEY_1, generation: 0 }],
			status: [true, true, 'sk-test…7890'],
		});
	});

	test('keeps keys in memory only while OS encryption is unavailable', async () => {
		const { service, storage, openai } = createFixture({ encryptionAvailable: false });

		await service.add('openai', KEY_1);

		const status = await openai();
		assert.deepStrictEqual(
			{ stored: storage.items.size, configured: status.configured, persistence: status.persistence },
			{ stored: 0, configured: true, persistence: 'in-memory' },
		);
	});

	test('reports a runtime that could not confirm a removal while leaving nothing stored', async () => {
		const { service, storage, handlers, openai } = createFixture();
		await service.add('openai', KEY_1);
		handlers.set('providerKeys.remove', async () => { throw new Error('1 running session could not confirm dropping it'); });

		const outcome = await service.remove('openai');

		assert.deepStrictEqual({
			outcome,
			stored: storage.items.get(SECRET_KEY),
			configured: (await openai()).configured,
		}, {
			outcome: { ok: false, message: '1 running session could not confirm dropping it', category: 'runtime' },
			stored: undefined,
			configured: false,
		});
	});

	test('never hands a secret to the status listing', async () => {
		const { service } = createFixture();
		await service.add('openai', KEY_1);
		assert.strictEqual(JSON.stringify(await service.list()).includes(KEY_1), false);
	});
});
