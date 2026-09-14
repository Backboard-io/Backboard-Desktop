/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import './media/backboardAuthSetup.css';

/** Shared account choices for Simple mode and every chat panel. */
export function renderBackboardAuthSetup(parent: HTMLElement, commands: ICommandService, refresh: () => Promise<void>): DisposableStore {
	const store = new DisposableStore();
	const actions = append(parent, $('.backboard-auth-setup-actions'));
	const status = append(parent, $('p.backboard-auth-setup-status'));
	status.setAttribute('role', 'status');
	const buttons: HTMLButtonElement[] = [];
	let disposed = false;
	store.add(toDisposable(() => { disposed = true; }));
	for (const [command, label] of [
		['backboard.signIn', localize('backboard.setup.sso', "Sign In with SSO")],
		['backboard.setupProviderKey', localize('backboard.setup.byok', "Set Up BYOK")],
		['backboard.setupSubscription', localize('backboard.setup.byos', "Set Up BYOS")],
	]) {
		const button = append(actions, $<HTMLButtonElement>('button.backboard-auth-gate-button'));
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
