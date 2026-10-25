/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';

/**
 * Restarts the whole app so the boot loader picks up a staged live update.
 * The Backboard extension owns live updates but cannot relaunch the app itself.
 */
CommandsRegistry.registerCommand('backboard.relaunchApp', accessor => accessor.get(INativeHostService).relaunch());
