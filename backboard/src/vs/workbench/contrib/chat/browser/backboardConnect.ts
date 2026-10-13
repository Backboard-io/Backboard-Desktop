/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, addDisposableListener, clearNode, EventHelper, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { BYOK_PROVIDERS, ByokProviderId } from '../../../../platform/agentHost/common/byokProviders.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { CHATGPT_SUBSCRIPTION_SETUP_ID, CHECK_CLAUDE_CODE_VERSION_COMMAND_ID, CLAUDE_SUBSCRIPTION_SETUP_ID, IClaudeCodeVersion, UPDATE_CLAUDE_CODE_COMMAND_ID } from './agentSessions/agentCliSetup.js';
import { ADD_PROVIDER_KEY_COMMAND_ID } from './byokKeys/byokKeys.js';
import './media/backboardConnect.css';

/** One way to pay for models: Backboard itself, a subscription, or the user's own key. */
export type BackboardConnectTarget = 'backboard' | 'chatgpt' | 'claude' | 'key';

/** What is already connected; drives each row's status and action label. */
export interface IBackboardConnectState {
	readonly signedIn: boolean;
	readonly chatGpt: boolean;
	readonly claude: boolean;
	/** Providers whose key is stored and active. */
	readonly keys: ReadonlySet<ByokProviderId>;
}

export interface IBackboardConnectOptions {
	/** Rows to show, in order. Defaults to every target available on this platform. */
	readonly targets?: readonly BackboardConnectTarget[];
	/** Called after a flow finished successfully, to re-read credentials or models. */
	onDidConnect(target: BackboardConnectTarget): Promise<void> | void;
}

export interface IBackboardConnectView {
	readonly store: DisposableStore;
	/** Scrolls a row into view and highlights it; for `key`, opens the key form, optionally on one provider. */
	reveal(target: BackboardConnectTarget, provider?: ByokProviderId): void;
}

export const EMPTY_BACKBOARD_CONNECT_STATE: IBackboardConnectState = { signedIn: false, chatGpt: false, claude: false, keys: new Set() };

/** The targets this platform supports; subscriptions are unavailable on Windows. */
export function defaultBackboardConnectTargets(): BackboardConnectTarget[] {
	return isWindows ? ['backboard', 'key'] : ['backboard', 'chatgpt', 'claude', 'key'];
}

const ROW_ICON: Record<BackboardConnectTarget, string> = {
	backboard: 'backboard',
	chatgpt: 'open-ai',
	claude: 'claude',
	key: 'key',
};

const KEY_ICON: Record<ByokProviderId, string> = {
	openai: 'open-ai',
	anthropic: 'anthropic',
	google: 'google',
	openrouter: 'open-router',
	xai: 'x-ai',
};

/**
 * The single place the user connects something that can pay for models:
 * Backboard sign-in, the ChatGPT and Claude subscriptions, or an API key typed
 * inline. The model picker and the signed-out card both render it, so there
 * is no separate pop-up per method.
 */
export function renderBackboardConnect(parent: HTMLElement, commands: ICommandService, state: IBackboardConnectState, options: IBackboardConnectOptions): IBackboardConnectView {
	const store = new DisposableStore();
	let disposed = false;
	store.add(toDisposable(() => { disposed = true; }));
	const root = append(parent, $('.backboard-connect'));
	const rows = new Map<BackboardConnectTarget, HTMLElement>();
	let busy: BackboardConnectTarget | undefined;
	let keyProvider: ByokProviderId = BYOK_PROVIDERS.find(provider => !state.keys.has(provider.id))?.id ?? BYOK_PROVIDERS[0].id;
	let keyFormOpen = false;
	let keyError = '';
	let keyDraft = '';
	/** Read once per render of the panel; an outdated Claude Code lists fewer models. */
	let claudeCode: IClaudeCodeVersion | undefined;
	let updatingClaudeCode = false;
	const claudeCodeOutdated = (): boolean => state.claude && claudeCode?.updateAvailable === true;

	const isConnected = (target: BackboardConnectTarget): boolean => {
		switch (target) {
			case 'backboard': return state.signedIn;
			case 'chatgpt': return state.chatGpt;
			case 'claude': return state.claude;
			case 'key': return state.keys.size > 0;
		}
	};

	const title = (target: BackboardConnectTarget): string => {
		switch (target) {
			case 'backboard': return localize('backboardConnect.backboard', "Backboard");
			case 'chatgpt': return localize('backboardConnect.chatGpt', "ChatGPT");
			case 'claude': return localize('backboardConnect.claude', "Claude");
			case 'key': return localize('backboardConnect.apiKey', "API Key");
		}
	};

	const description = (target: BackboardConnectTarget): string => {
		if (busy === target && target === 'claude' && updatingClaudeCode) {
			return localize('backboardConnect.updatingClaudeCode', "Updating Claude Code…");
		}
		if (busy === target) {
			return target === 'key'
				? localize('backboardConnect.validating', "Checking the key…")
				: localize('backboardConnect.waiting', "Finish signing in in your browser…");
		}
		switch (target) {
			case 'backboard': return state.signedIn
				? localize('backboardConnect.backboardConnected', "Signed in. Every model, billed to Backboard")
				: localize('backboardConnect.backboardDescription', "Every model, billed to your Backboard account");
			case 'chatgpt': return state.chatGpt
				? localize('backboardConnect.chatGptConnected', "Connected. GPT models use your plan")
				: localize('backboardConnect.chatGptDescription', "Use GPT models included with your plan");
			case 'claude': return claudeCodeOutdated()
				? localize('backboardConnect.claudeCodeOutdated', "Claude Code {0} is out of date. Update to see every model", claudeCode!.installed)
				: state.claude
				? localize('backboardConnect.claudeConnected', "Connected. Claude models use your plan")
				: localize('backboardConnect.claudeDescription', "Use Claude models included with your plan");
			case 'key': return state.keys.size
				? localize('backboardConnect.keysConnected', "{0} connected", BYOK_PROVIDERS.filter(provider => state.keys.has(provider.id)).map(provider => provider.label).join(', '))
				: localize('backboardConnect.keyDescription', "OpenAI, Anthropic, Gemini, OpenRouter or xAI");
		}
	};

	const actionLabel = (target: BackboardConnectTarget): string => {
		if (target === 'key') {
			return state.keys.size ? localize('backboardConnect.addAnother', "Add Key") : localize('backboardConnect.addKey', "Add Key");
		}
		if (target === 'backboard') {
			return state.signedIn ? localize('backboardConnect.signedIn', "Signed In") : localize('backboardConnect.signIn', "Sign In");
		}
		if (target === 'claude' && claudeCodeOutdated()) {
			return localize('backboardConnect.update', "Update");
		}
		return isConnected(target) ? localize('backboardConnect.reconnect', "Reconnect") : localize('backboardConnect.connect', "Connect");
	};

	const run = async (target: BackboardConnectTarget, work: () => Promise<unknown>): Promise<boolean> => {
		busy = target;
		render();
		try {
			await work();
			if (!disposed) {
				await options.onDidConnect(target);
			}
			return true;
		} catch (error) {
			if (target === 'key') {
				keyError = error instanceof Error && error.message ? error.message : localize('backboardConnect.keyFailed', "That key did not work. Check it and try again.");
			}
			return false;
		} finally {
			busy = undefined;
			if (!disposed) {
				render();
			}
		}
	};

	const activate = (target: BackboardConnectTarget): void => {
		if (busy) {
			return;
		}
		switch (target) {
			case 'backboard':
				if (!state.signedIn) {
					void run(target, () => commands.executeCommand('backboard.signIn'));
				}
				return;
			case 'chatgpt':
				void run(target, () => commands.executeCommand('backboard.setupSubscription', CHATGPT_SUBSCRIPTION_SETUP_ID));
				return;
			case 'claude':
				if (claudeCodeOutdated()) {
					updatingClaudeCode = true;
					void run(target, async () => {
						await commands.executeCommand(UPDATE_CLAUDE_CODE_COMMAND_ID);
						claudeCode = await commands.executeCommand<IClaudeCodeVersion | undefined>(CHECK_CLAUDE_CODE_VERSION_COMMAND_ID);
					}).finally(() => { updatingClaudeCode = false; });
					return;
				}
				void run(target, () => commands.executeCommand('backboard.setupSubscription', CLAUDE_SUBSCRIPTION_SETUP_ID));
				return;
			case 'key':
				keyFormOpen = !keyFormOpen;
				keyError = '';
				render();
				if (keyFormOpen) {
					root.querySelector<HTMLInputElement>('.backboard-connect-key-input')?.focus();
				}
				return;
		}
	};

	const submitKey = async (): Promise<void> => {
		const key = keyDraft.trim();
		const definition = BYOK_PROVIDERS.find(provider => provider.id === keyProvider)!;
		if (!key) {
			return;
		}
		if (!definition.looksLikeKey(key)) {
			keyError = localize('backboardConnect.keyShape', "That does not look like a {0} key (expected {1}).", definition.label, definition.keyHint);
			render();
			return;
		}
		keyError = '';
		if (await run('key', () => commands.executeCommand(ADD_PROVIDER_KEY_COMMAND_ID, keyProvider, key))) {
			keyDraft = '';
			keyFormOpen = false;
			if (!disposed) {
				render();
			}
		}
	};

	const renderKeyForm = (container: HTMLElement, rowStore: DisposableStore): void => {
		const form = append(container, $('.backboard-connect-key-form'));
		const providers = append(form, $('.backboard-connect-key-providers'));
		providers.setAttribute('role', 'radiogroup');
		providers.setAttribute('aria-label', localize('backboardConnect.keyProvider', "Key provider"));
		for (const provider of BYOK_PROVIDERS) {
			const pill = append(providers, $<HTMLButtonElement>('button.backboard-connect-key-provider'));
			pill.type = 'button';
			pill.setAttribute('role', 'radio');
			pill.setAttribute('aria-checked', String(provider.id === keyProvider));
			pill.classList.toggle('selected', provider.id === keyProvider);
			append(pill, $(`span.backboard-connect-icon.provider-${KEY_ICON[provider.id]}`)).setAttribute('aria-hidden', 'true');
			append(pill, $('span')).textContent = provider.label;
			if (state.keys.has(provider.id)) {
				append(pill, $('span.backboard-connect-dot')).setAttribute('aria-hidden', 'true');
			}
			rowStore.add(addDisposableListener(pill, EventType.CLICK, event => {
				EventHelper.stop(event, true);
				keyProvider = provider.id;
				keyError = '';
				render();
				root.querySelector<HTMLInputElement>('.backboard-connect-key-input')?.focus();
			}));
		}
		const definition = BYOK_PROVIDERS.find(provider => provider.id === keyProvider)!;
		const field = append(form, $('.backboard-connect-key-field'));
		const input = append(field, $<HTMLInputElement>('input.backboard-connect-key-input'));
		input.type = 'password';
		input.autocomplete = 'off';
		input.spellcheck = false;
		input.placeholder = localize('backboardConnect.keyPlaceholder', "Paste your {0} key ({1})", definition.label, definition.keyHint);
		input.setAttribute('aria-label', input.placeholder);
		input.value = keyDraft;
		input.disabled = busy === 'key';
		const save = append(field, $<HTMLButtonElement>('button.backboard-connect-key-save'));
		save.type = 'button';
		save.textContent = localize('backboardConnect.save', "Save");
		save.disabled = busy === 'key' || !keyDraft.trim();
		rowStore.add(addDisposableListener(input, EventType.INPUT, () => {
			keyDraft = input.value;
			save.disabled = !keyDraft.trim();
		}));
		rowStore.add(addDisposableListener(input, EventType.KEY_DOWN, event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.equals(KeyCode.Enter)) {
				EventHelper.stop(event, true);
				void submitKey();
			} else if (keyboardEvent.equals(KeyCode.Escape)) {
				EventHelper.stop(event, true);
				keyFormOpen = false;
				render();
			}
		}));
		rowStore.add(addDisposableListener(save, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			void submitKey();
		}));
		const footer = append(form, $('.backboard-connect-key-footer'));
		const note = append(footer, $('span.backboard-connect-key-note'));
		note.textContent = keyError || localize('backboardConnect.keyNote', "Stored in your OS keychain and sent only to {0}.", definition.label);
		note.classList.toggle('error', !!keyError);
		const link = append(footer, $<HTMLButtonElement>('button.backboard-connect-key-link'));
		link.type = 'button';
		link.textContent = localize('backboardConnect.getKey', "Get a Key");
		rowStore.add(addDisposableListener(link, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			void commands.executeCommand('vscode.open', URI.parse(definition.consoleUrl));
		}));
	};

	const renderStore = store.add(new DisposableStore());
	const targets = (options.targets ?? defaultBackboardConnectTargets()).filter(target => !isWindows || target === 'backboard' || target === 'key');
	const render = (): void => {
		renderStore.clear();
		clearNode(root);
		rows.clear();
		for (const target of targets) {
			const connected = isConnected(target);
			const item = append(root, $('.backboard-connect-item'));
			const row = append(item, $<HTMLButtonElement>('button.backboard-connect-row'));
			row.type = 'button';
			row.dataset.target = target;
			row.classList.toggle('connected', connected);
			row.classList.toggle('update-available', target === 'claude' && claudeCodeOutdated());
			row.classList.toggle('busy', busy === target);
			row.classList.toggle('expanded', target === 'key' && keyFormOpen);
			row.disabled = (!!busy && busy !== target) || (target === 'backboard' && state.signedIn);
			rows.set(target, item);
			if (target === 'key') {
				row.appendChild(renderIcon(Codicon.key));
			} else {
				append(row, $(`span.backboard-connect-icon.provider-${ROW_ICON[target]}`)).setAttribute('aria-hidden', 'true');
			}
			const copy = append(row, $('span.backboard-connect-copy'));
			const heading = append(copy, $('span.backboard-connect-title'));
			heading.textContent = title(target);
			if (connected) {
				append(heading, $('span.backboard-connect-dot')).setAttribute('aria-hidden', 'true');
			}
			append(copy, $('span.backboard-connect-description')).textContent = description(target);
			const action = append(row, $('span.backboard-connect-action'));
			if (busy === target) {
				action.appendChild(renderIcon(Codicon.loading)).classList.add('codicon-modifier-spin');
			} else if (target === 'key') {
				action.textContent = actionLabel(target);
				action.appendChild(renderIcon(keyFormOpen ? Codicon.chevronUp : Codicon.chevronDown));
			} else {
				action.textContent = actionLabel(target);
			}
			row.setAttribute('aria-label', `${title(target)}: ${description(target)}`);
			if (target === 'key') {
				row.setAttribute('aria-expanded', String(keyFormOpen));
			}
			renderStore.add(addDisposableListener(row, EventType.CLICK, event => {
				EventHelper.stop(event, true);
				activate(target);
			}));
			if (target === 'key' && keyFormOpen) {
				renderKeyForm(item, renderStore);
			}
		}
	};

	render();
	if (state.claude && targets.includes('claude')) {
		commands.executeCommand<IClaudeCodeVersion | undefined>(CHECK_CLAUDE_CODE_VERSION_COMMAND_ID).then(version => {
			if (!disposed && version?.updateAvailable && !busy) {
				claudeCode = version;
				render();
			}
		}, () => { /* No version, no prompt. */ });
	}
	return {
		store,
		reveal: (target, provider) => {
			if (target === 'key') {
				keyFormOpen = true;
				if (provider) {
					keyProvider = provider;
				}
				render();
			}
			const item = rows.get(target);
			if (!item) {
				return;
			}
			item.scrollIntoView({ block: 'nearest' });
			item.classList.remove('flash');
			// Restart the highlight animation on repeated reveals.
			void item.offsetWidth;
			item.classList.add('flash');
			(item.querySelector<HTMLInputElement>('.backboard-connect-key-input') ?? item.querySelector<HTMLButtonElement>('.backboard-connect-row'))?.focus();
		},
	};
}
