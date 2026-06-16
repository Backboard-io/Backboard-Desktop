/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerAction2 } from '../../platform/actions/common/actions.js';
import { OpenInVSCodeAction } from './actions/vscodeActions.js';

// Actions
(function registerActions(): void {
	registerAction2(OpenInVSCodeAction);
})();
