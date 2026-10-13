/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { EMPTY_BACKBOARD_CONNECT_STATE, renderBackboardConnect } from './backboardConnect.js';
import './media/backboardAuthSetup.css';
import './backboardAuthService.js';

/**
 * Shared account choices for Simple mode and every chat panel: the same inline
 * Connect list the model picker shows. The card is only visible while nothing
 * is connected, so every row starts in its "connect" state.
 */
export function renderBackboardAuthSetup(parent: HTMLElement, commands: ICommandService, refresh: () => Promise<void>): DisposableStore {
	const container = append(parent, $('.backboard-auth-setup-connect'));
	return renderBackboardConnect(container, commands, EMPTY_BACKBOARD_CONNECT_STATE, { onDidConnect: () => refresh() }).store;
}
