/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { BackboardAuthContextKeys, BackboardAuthGateContextKeys, IBackboardAuthService } from '../common/backboardAuth.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import './media/backboardAuthSetup.css';
import './backboardAuthService.js';

/** Shared account choices for Simple mode and every chat panel. */
export function renderBackboardAuthSetup(parent: HTMLElement, commands: ICommandService, refresh: () => Promise<void>, windows = isWindows): DisposableStore {
	const store = new DisposableStore();
	parent.classList.add('backboard-auth-setup-card');
	const actions = append(parent, $('.backboard-auth-setup-actions'));
	const status = append(parent, $('p.backboard-auth-setup-status'));
	status.setAttribute('role', 'status');
	const buttons: HTMLButtonElement[] = [];
	let disposed = false;
	store.add(toDisposable(() => { disposed = true; }));
	for (const [command, label] of [
		['backboard.signIn', windows ? localize('backboard.setup.signIn', "Sign In") : localize('backboard.setup.sso', "Sign In with SSO")],
		['backboard.setupProviderKey', localize('backboard.setup.byok', "Use API Key")],
	]) {
		const button = append(actions, $<HTMLButtonElement>('button.backboard-auth-gate-button'));
		button.classList.add(command === 'backboard.signIn' ? 'primary' : 'secondary');
		button.type = 'button';
		button.textContent = label;
		buttons.push(button);
		store.add(addDisposableListener(button, EventType.CLICK, async () => {
			buttons.forEach(item => { item.disabled = true; });
			status.textContent = '';
			try {
				await commands.executeCommand(command);
				if (!disposed) { await refresh(); }
			} catch {
				if (!disposed) { status.textContent = localize('backboard.setup.failed', "Setup failed. Please try again."); }
			} finally {
				if (!disposed) { buttons.forEach(item => { item.disabled = false; }); }
			}
		}));
	}
	return store;
}

/** Shared sign-in surface for dashboard and chat hosts that do not own a gate. */
export function renderBackboardAuthGate(parent: HTMLElement, commands: ICommandService, context: IContextKeyService, auth: IBackboardAuthService): DisposableStore {
	const store = new DisposableStore();
	parent.classList.add('backboard-auth-gate-host');
	const overlay = append(parent, $('.backboard-auth-gate-overlay'));
	overlay.setAttribute('role', 'dialog');
	overlay.setAttribute('aria-label', localize('backboard.setup.title', "Connect Your AI"));
	const card = append(overlay, $('.backboard-auth-gate-card'));
	append(card, $('span.backboard-auth-gate-logo.codicon.codicon-backboard-logo', { 'aria-hidden': 'true' }));
	append(card, $('h3.backboard-auth-gate-title')).textContent = localize('backboard.setup.title', "Connect Your AI");
	append(card, $('p.backboard-auth-gate-description')).textContent = localize('backboard.setup.description.windows', "Use Backboard or an API key.");
	store.add(renderBackboardAuthSetup(card, commands, () => auth.refresh()));
	const update = () => {
		const gated = context.getContextKeyValue(BackboardAuthContextKeys.enabled.key) === true
			&& context.getContextKeyValue(BackboardAuthContextKeys.signedIn.key) !== true
			&& context.getContextKeyValue(BackboardAuthContextKeys.alternativeConfigured.key) !== true;
		parent.classList.toggle('backboard-auth-gate-active', gated);
		overlay.hidden = !gated;
	};
	store.add(context.onDidChangeContext(event => { if (event.affectsSome(BackboardAuthGateContextKeys)) { update(); } }));
	store.add(toDisposable(() => { overlay.remove(); parent.classList.remove('backboard-auth-gate-host', 'backboard-auth-gate-active'); }));
	update();
	return store;
}
