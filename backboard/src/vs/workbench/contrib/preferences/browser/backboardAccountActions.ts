/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';

export function renderBackboardAccountActions(container: HTMLElement, commandService: ICommandService, disposables: DisposableStore): void {
	const actions = DOM.append(container, DOM.$('.backboard-account-actions'));
	for (const [command, label, description] of [
		['backboard.signOut', localize('backboard.settings.signOut', "Sign Out"), localize('backboard.settings.signOutDescription', "Remove saved API keys and sign out of Backboard on this device.")],
		['backboard.deleteAccount', localize('backboard.settings.deleteAccount', "Delete Account"), localize('backboard.settings.deleteAccountDescription', "Open the Backboard dashboard to manage account deletion.")],
	]) {
		const row = DOM.append(actions, DOM.$('.backboard-account-action'));
		const text = DOM.append(row, DOM.$('.backboard-account-action-copy'));
		DOM.append(text, DOM.$('.backboard-account-action-label')).textContent = label;
		DOM.append(text, DOM.$('.backboard-account-action-description')).textContent = description;
		const button = disposables.add(new Button(row, { ...defaultButtonStyles, secondary: true }));
		button.label = label;
		disposables.add(button.onDidClick(async () => {
			button.enabled = false;
			try {
				await commandService.executeCommand(command);
			} catch (error) {
				onUnexpectedError(error);
			} finally {
				button.enabled = true;
			}
		}));
	}
}
