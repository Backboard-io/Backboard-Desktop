/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentHostByosToggle.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { SessionConfigKey } from '../../../../../../platform/agentHost/common/sessionConfigKeys.js';
import type { IChatWidget } from '../../chat.js';
import { AgentHostChatInputPicker } from './agentHostChatInputPicker.js';
import { IAgentHostRememberedSessionConfigService } from './agentHostRememberedSessionConfig.js';
import { IAgentHostSubscriptionAuthService, SubscriptionAuthProvider } from './agentHostSubscriptionAuth.js';

function toSubscriptionAuthProvider(provider: string | undefined): SubscriptionAuthProvider | undefined {
	// Only the local Claude / Codex agents are login-checkable: the check
	// reads the local user home, which is meaningless for remote agent
	// hosts (whose provider schemes carry a remote suffix).
	return provider === 'claude' || provider === 'codex' ? provider : undefined;
}

/**
 * "Use my subscription" row rendered above the composer's input toolbars.
 *
 * Composes an {@link AgentHostChatInputPicker} bound to
 * {@link SessionConfigKey.Billing}, inheriting its schema gating (the row
 * self-hides for agents that don't advertise the property — e.g. Copilot /
 * cli-ts sessions), its dropdown, and its value dispatch. On top of that it
 * adds:
 *
 * - a sticky default: picks are written through
 *   {@link IAgentHostRememberedSessionConfigService} so the next new session
 *   starts with the same billing mode;
 * - a login check: when subscription billing is selected but the user has no
 *   provider CLI login, an inline warning offers to run the login command in
 *   a terminal;
 * - a read-only "Billed to" chip state for started sessions (the property is
 *   `sessionMutable: false`, so the picker itself hides post-send).
 */
export class AgentHostByosToggle extends Disposable {

	private readonly _picker: AgentHostChatInputPicker;
	private readonly _warningDisposables = this._register(new DisposableStore());

	private _rowContainer: HTMLElement | undefined;
	private _pickerContainer: HTMLElement | undefined;
	private _startedLabelContainer: HTMLElement | undefined;
	private _warningContainer: HTMLElement | undefined;
	/** Monotonic guard so an outdated async login check never paints over a newer one. */
	private _loginCheckGeneration = 0;

	constructor(
		private readonly _widget: IChatWidget,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAgentHostRememberedSessionConfigService private readonly _rememberedSessionConfig: IAgentHostRememberedSessionConfigService,
		@IAgentHostSubscriptionAuthService private readonly _subscriptionAuth: IAgentHostSubscriptionAuthService,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super();
		this._picker = this._register(instantiationService.createInstance(AgentHostChatInputPicker, this._widget, SessionConfigKey.Billing));
		this._register(this._picker.onDidRenderChip(() => this._update()));
		this._register(this._picker.onDidSelectValue(value => {
			this._rememberedSessionConfig.set(SessionConfigKey.Billing, value);
			this._subscriptionAuth.refresh();
			this._update();
		}));
	}

	render(container: HTMLElement): void {
		this._rowContainer = container;
		container.classList.add('chat-byos-toggle-row');
		container.style.display = 'none';
		this._pickerContainer = dom.append(container, dom.$('.chat-byos-toggle-picker'));
		this._startedLabelContainer = dom.append(container, dom.$('.chat-byos-started-label'));
		this._startedLabelContainer.style.display = 'none';
		this._warningContainer = dom.append(container, dom.$('.chat-byos-login-warning'));
		this._warningContainer.style.display = 'none';
		this._picker.render(this._pickerContainer);
		this._update();
	}

	private _update(): void {
		const row = this._rowContainer;
		if (!row || !this._pickerContainer || !this._warningContainer || !this._startedLabelContainer) {
			return;
		}

		const chipVisible = !this._pickerContainer.classList.contains('agent-host-chat-input-picker-host-hidden')
			&& this._picker.hasContext();
		const value = this._picker.getCurrentValue();

		// Started sessions hide the interactive chip (billing is
		// creation-time-only); still surface subscription billing read-only
		// so the user can tell who pays for the running session.
		const showStartedLabel = !chipVisible && value === 'subscription';
		this._startedLabelContainer.style.display = showStartedLabel ? '' : 'none';
		if (showStartedLabel) {
			dom.clearNode(this._startedLabelContainer);
			dom.append(this._startedLabelContainer, renderIcon(Codicon.account));
			const text = dom.append(this._startedLabelContainer, dom.$('span'));
			text.textContent = localize('byosToggle.billedToSubscription', "Billed to your subscription");
		}

		row.style.display = chipVisible || showStartedLabel ? '' : 'none';

		this._updateLoginWarning(value === 'subscription');
	}

	private _updateLoginWarning(subscriptionSelected: boolean): void {
		const warning = this._warningContainer;
		if (!warning) {
			return;
		}
		const generation = ++this._loginCheckGeneration;
		const provider = toSubscriptionAuthProvider(this._picker.getBackendProvider());
		if (!subscriptionSelected || !provider) {
			warning.style.display = 'none';
			this._warningDisposables.clear();
			return;
		}
		void this._subscriptionAuth.getLoginStatus(provider).then(status => {
			if (this._store.isDisposed || generation !== this._loginCheckGeneration) {
				return;
			}
			if (status !== false) {
				warning.style.display = 'none';
				this._warningDisposables.clear();
				return;
			}
			this._renderLoginWarning(warning, provider);
		});
	}

	private _renderLoginWarning(warning: HTMLElement, provider: SubscriptionAuthProvider): void {
		this._warningDisposables.clear();
		dom.clearNode(warning);
		warning.style.display = '';

		dom.append(warning, renderIcon(Codicon.warning));
		const message = dom.append(warning, dom.$('span.chat-byos-login-warning-message'));
		message.textContent = provider === 'claude'
			? localize('byosToggle.claudeNotLoggedIn', "Not logged in to Claude Code")
			: localize('byosToggle.codexNotLoggedIn', "Not logged in to Codex");

		const loginButton = dom.append(warning, dom.$('a.chat-byos-login-warning-action'));
		loginButton.role = 'button';
		loginButton.tabIndex = 0;
		loginButton.textContent = localize('byosToggle.logIn', "Log In in Terminal");
		this._warningDisposables.add(this._hoverService.setupDelayedHover(loginButton, {
			content: localize('byosToggle.logInHover', "Opens a terminal running `{0}`. Once you have logged in, come back here.", this._subscriptionAuth.getLoginCommand(provider)),
		}));
		const runLogin = () => {
			void this._subscriptionAuth.openLoginTerminal(provider);
			// Re-check once the user returns focus to the composer.
			this._subscriptionAuth.refresh();
		};
		this._warningDisposables.add(dom.addDisposableListener(loginButton, dom.EventType.CLICK, e => {
			dom.EventHelper.stop(e, true);
			runLogin();
		}));
		this._warningDisposables.add(dom.addDisposableListener(loginButton, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				dom.EventHelper.stop(e, true);
				runLogin();
			}
		}));

		const recheckButton = dom.append(warning, dom.$('a.chat-byos-login-warning-action'));
		recheckButton.role = 'button';
		recheckButton.tabIndex = 0;
		recheckButton.textContent = localize('byosToggle.recheck', "Recheck");
		this._warningDisposables.add(dom.addDisposableListener(recheckButton, dom.EventType.CLICK, e => {
			dom.EventHelper.stop(e, true);
			this._subscriptionAuth.refresh();
			this._update();
		}));
	}
}
