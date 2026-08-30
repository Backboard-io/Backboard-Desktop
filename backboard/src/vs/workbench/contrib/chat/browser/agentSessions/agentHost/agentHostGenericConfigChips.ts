/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableMap, IDisposable, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IAgentHostService } from '../../../../../../platform/agentHost/common/agentService.js';
import type { ResolveSessionConfigResult, SessionConfigPropertySchema } from '../../../../../../platform/agentHost/common/state/protocol/commands.js';
import type { SessionState } from '../../../../../../platform/agentHost/common/state/protocol/state.js';
import { StateComponents } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { type IAgentSubscription } from '../../../../../../platform/agentHost/common/state/agentSubscription.js';
import { isUntitledChatSession } from '../../../common/model/chatUri.js';
import type { IChatWidget } from '../../chat.js';
import { AgentHostChatInputPicker, isBackboardAccessModeSchema, isClaimedByDedicatedPicker } from './agentHostChatInputPicker.js';
import { resolveSessionConfigShared } from './agentHostSessionConfigResolveCache.js';
import { IAgentHostSessionWorkingDirectoryResolver } from './agentHostSessionWorkingDirectoryResolver.js';
import { IAgentHostNewSessionFolderService } from './agentHostNewSessionFolderService.js';
import { IAgentHostUntitledProvisionalSessionService } from './agentHostUntitledProvisionalSessionService.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { toAgentHostBackendSessionUri } from './agentHostSessionUri.js';

export interface IAgentHostGenericConfigOption {
	readonly id: string;
	readonly label: string;
	readonly valueLabel?: string;
	readonly description?: string;
	/** Whether this option is currently set to a non-default (active) value. */
	readonly active: boolean;
	/** Whether this capability is enabled and should be shown inside the composer. */
	readonly composerSelected: boolean;
	/** Value applied when the capability is chosen from the one-click Add menu. */
	readonly activationValue?: string;
	/** Value applied when its inline composer token is removed. */
	readonly deactivationValue?: string;
	show(anchor?: HTMLElement): void;
	/** Static enum metadata for slider-style editors; `undefined` for non-enum properties. */
	getEnumInfo(): { values: string[]; labels: string[]; descriptions: (string | undefined)[]; current: string | undefined } | undefined;
	/** Applies a value directly, bypassing the list popup (used by slider-style editors). */
	setValue(value: string): void;
}

interface IAgentHostGenericConfigChipEntry extends IDisposable {
	readonly chip: AgentHostChatInputPicker;
	readonly slot: HTMLElement;
}

function isVisibleGenericConfigProperty(property: string, schema: SessionConfigPropertySchema): boolean {
	return !isClaimedByDedicatedPicker(property, schema) || isBackboardAccessModeSchema(property, schema);
}

function getVisibleGenericConfigLabel(property: string, schema: SessionConfigPropertySchema): string {
	if (isBackboardAccessModeSchema(property, schema)) {
		return schema.enum?.includes('multitask')
			? localize('backboard.config.mode.title', "Mode")
			: localize('backboard.config.approvals.title', "Approvals");
	}
	return schema.title || property;
}

const composerCapabilityProperties = new Set([
	'webSearch',
	'web',
	'memory',
	'memoryMode',
	'computerUse',
	'cua',
	'browserUse',
	'browser',
	'notifications',
	'notify',
	'imageGeneration',
	'images',
]);

function getComposerActivationValue(property: string, schema: SessionConfigPropertySchema): string | undefined {
	if (!composerCapabilityProperties.has(property)) {
		return undefined;
	}
	if (schema.type === 'boolean') {
		return 'true';
	}
	if ((property === 'memory' || property === 'memoryMode') && schema.enum?.includes('auto')) {
		return 'auto';
	}
	return schema.enum?.find(value => value === 'on' || value === 'enabled');
}

function getComposerDeactivationValue(property: string, schema: SessionConfigPropertySchema): string | undefined {
	if (!composerCapabilityProperties.has(property)) {
		return undefined;
	}
	if (schema.type === 'boolean') {
		return 'false';
	}
	return schema.enum?.find(value => value === 'off' || value === 'disabled' || value === 'false')
		?? (typeof schema.default === 'string' ? schema.default : undefined);
}

function isComposerCapabilitySelected(property: string, schema: SessionConfigPropertySchema, value: unknown): boolean {
	if (!composerCapabilityProperties.has(property)) {
		return false;
	}
	if (schema.type === 'boolean') {
		return value === true;
	}
	return typeof value === 'string' && value !== 'off' && value !== 'false' && value !== 'disabled';
}

/**
 * Direct-render chip lane for agent-host session-config properties that are
 * advertised by the agent's schema but are NOT handled by a dedicated
 * well-known picker (e.g. Claude's custom approval-mode property).
 *
 * Unlike the dedicated chips, this lane is not registered with
 * dedicated `MenuId.ChatInput` action. It owns its own DOM container and creates
 * one {@link AgentHostChatInputPicker} per generic property, syncing the
 * set of chips whenever the active session's schema changes.
 */
export class AgentHostGenericConfigChips extends Disposable {

	private _container: HTMLElement | undefined;

	private readonly _onDidChangeOptions = this._register(new Emitter<void>());
	/** Fires when the set of options or any option's active state may have changed. */
	readonly onDidChangeOptions: Event<void> = this._onDidChangeOptions.event;

	private readonly _chips = this._register(new DisposableMap<string, IAgentHostGenericConfigChipEntry>());

	/**
	 * Subscription to the active session's backend state. Maintained for the
	 * lifetime of any one (sessionResource, backendSession) pair; replaced
	 * via {@link _reattach} when the active session changes.
	 */
	private readonly _subRef = this._register(new MutableDisposable<IDisposable & {
		readonly sub: IAgentSubscription<SessionState>;
		readonly backendSession: URI;
	}>());

	private _initialResolved: { readonly sessionResource: URI; readonly result: ResolveSessionConfigResult } | undefined;
	private readonly _initialResolveCts = this._register(new MutableDisposable<CancellationTokenSource>());

	constructor(
		private readonly _widget: IChatWidget,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IAgentHostUntitledProvisionalSessionService private readonly _provisional: IAgentHostUntitledProvisionalSessionService,
		@IAgentHostSessionWorkingDirectoryResolver private readonly _workingDirectoryResolver: IAgentHostSessionWorkingDirectoryResolver,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IAgentHostNewSessionFolderService private readonly _newSessionFolderService: IAgentHostNewSessionFolderService,
	) {
		super();
		this._register(this._widget.onDidChangeViewModel(() => {
			this._reattach();
			this._onDidChangeOptions.fire();
		}));
		this._register(this._provisional.onDidChange((sessionResource: URI) => {
			const current = this._widget.viewModel?.sessionResource;
			if (current && current.toString() === sessionResource.toString()) {
				this._reattach();
				this._onDidChangeOptions.fire();
			}
		}));
		this._reattach();
	}

	render(container: HTMLElement): void {
		this._container = container;
		this._sync();
	}

	/**
	 * Whether the session-config schema has arrived. While false, an empty
	 * {@link getOptions} result means "still loading", not "no options" —
	 * consumers should render a loading state instead of an empty one.
	 */
	hasResolvedSchema(): boolean {
		return this._readSchemaProperties() !== undefined;
	}

	getOptions(): readonly IAgentHostGenericConfigOption[] {
		this._sync();
		const entries = this._readSchemaProperties();
		if (!entries) {
			return [];
		}

		const options: IAgentHostGenericConfigOption[] = [];
		for (const [property, schema] of entries) {
			if (!isVisibleGenericConfigProperty(property, schema)) {
				continue;
			}
			const chip = this._chips.get(property)?.chip;
			if (!chip) {
				continue;
			}
			const value = chip.getCurrentValue();
			options.push({
				id: property,
				label: getVisibleGenericConfigLabel(property, schema),
				valueLabel: chip.getCurrentLabel(),
				description: schema.description,
				active: chip.isActive(),
				composerSelected: isComposerCapabilitySelected(property, schema, value),
				activationValue: getComposerActivationValue(property, schema),
				deactivationValue: getComposerDeactivationValue(property, schema),
				show: (anchor?: HTMLElement) => chip.show(anchor),
				getEnumInfo: () => chip.getEnumInfo(),
				setValue: value => chip.setValue(value),
			});
		}
		return options;
	}

	private _reattach(): void {
		const sessionResource = this._widget.viewModel?.sessionResource;
		const provisionalBackend = sessionResource ? this._provisional.get(sessionResource) : undefined;
		const backendSession = provisionalBackend
			?? (sessionResource ? toAgentHostBackendSessionUri(sessionResource) : undefined);

		if (!sessionResource || !backendSession) {
			this._subRef.clear();
			this._initialResolved = undefined;
			this._cancelInitialResolve();
			this._sync();
			return;
		}

		if (isUntitledChatSession(sessionResource) && !provisionalBackend) {
			this._subRef.clear();
			if (!this._initialResolved || this._initialResolved.sessionResource.toString() !== sessionResource.toString()) {
				this._initialResolved = undefined;
				void this._refreshInitialResolved(sessionResource, backendSession);
			}
			this._sync();
			return;
		}

		this._initialResolved = undefined;
		this._cancelInitialResolve();
		const ref = this._agentHostService.getSubscription(StateComponents.Session, backendSession, 'AgentHostGenericConfigChips');
		const sub = ref.object;
		const listener = sub.onDidChange(() => {
			this._sync();
			this._onDidChangeOptions.fire();
		});
		this._subRef.value = {
			sub,
			backendSession,
			dispose: () => { listener.dispose(); ref.dispose(); },
		};
		this._sync();
	}

	private _cancelInitialResolve(): void {
		this._initialResolveCts.value?.cancel();
		this._initialResolveCts.clear();
	}

	private async _refreshInitialResolved(sessionResource: URI, backendSession: URI): Promise<void> {
		this._initialResolveCts.value?.cancel();
		const cts = new CancellationTokenSource();
		this._initialResolveCts.value = cts;
		try {
			const result = await resolveSessionConfigShared(this._agentHostService, {
				provider: backendSession.scheme,
				workingDirectory: this._readWorkingDirectory(),
			});
			if (cts.token.isCancellationRequested || this._widget.viewModel?.sessionResource?.toString() !== sessionResource.toString()) {
				return;
			}
			this._initialResolved = { sessionResource, result };
			this._sync();
			this._onDidChangeOptions.fire();
		} catch {
			// Best-effort.
		}
	}

	private _readWorkingDirectory(): URI | undefined {
		const state = this._subRef.value?.sub.value;
		if (state && !(state instanceof Error)) {
			const cwd = state.summary.workingDirectory;
			return typeof cwd === 'string' ? URI.parse(cwd) : cwd;
		}
		const sessionResource = this._widget.viewModel?.sessionResource;
		return (sessionResource && this._newSessionFolderService.getFolder(sessionResource))
			?? (sessionResource && this._workingDirectoryResolver.resolve(sessionResource))
			?? this._workspaceContextService.getWorkspace().folders[0]?.uri;
	}

	private _readSchemaProperties(): readonly [string, SessionConfigPropertySchema][] | undefined {
		const sessionResource = this._widget.viewModel?.sessionResource;
		if (this._subRef.value) {
			const state = this._subRef.value.sub.value;
			if (!state || state instanceof Error || !state.config) {
				return undefined;
			}
			const overlay = sessionResource ? this._provisional.getResolvedConfig(sessionResource) : undefined;
			return Object.entries((overlay?.schema ?? state.config.schema).properties);
		}
		if (this._initialResolved && sessionResource && this._initialResolved.sessionResource.toString() === sessionResource.toString()) {
			return Object.entries(this._initialResolved.result.schema.properties);
		}
		return undefined;
	}

	private _sync(): void {
		if (!this._container) {
			return;
		}
		const entries = this._readSchemaProperties();
		const desired = new Set<string>();
		if (entries) {
			for (const [property, schema] of entries) {
				if (!isVisibleGenericConfigProperty(property, schema)) {
					continue;
				}
				desired.add(property);
			}
		}

		// Remove chips for properties no longer in the schema (or now claimed
		// by a dedicated picker).
		for (const property of [...this._chips.keys()]) {
			if (!desired.has(property)) {
				this._chips.deleteAndDispose(property);
			}
		}

		// Add chips for newly-appearing generic properties.
		for (const property of desired) {
			if (this._chips.has(property)) {
				continue;
			}
			const chip = this._instantiationService.createInstance(AgentHostChatInputPicker, this._widget, property);
			// `chat-input-picker-item` matches the class that
			// `ChatInputPickerActionViewItem` applies to the dedicated
			// chips' container — required so the secondary-toolbar styling
			// in `chat.css` (height, padding, chevron) applies here too.
			const slot = dom.append(this._container, dom.$('.agent-host-generic-chip-slot.chat-input-picker-item'));
			chip.render(slot);
			this._chips.set(property, {
				chip,
				slot,
				dispose: () => {
					chip.dispose();
					slot.remove();
				},
			});
		}
	}
}
