/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { CANVAS_HOSTED_MEDIA_TIME_COMMAND_ID } from '../browser/rightWorkbench.js';

// Generated media is uploaded once, so its host's Last-Modified is when it was generated.
CommandsRegistry.registerCommand(CANVAS_HOSTED_MEDIA_TIME_COMMAND_ID, (accessor, url: string) => accessor.get(INativeHostService).getRemoteLastModified(url));
