/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../browser/backboardAuthService.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { BackboardCredentialsContribution, registerBackboardSsoActions } from './actions/backboardSsoActions.js';

registerBackboardSsoActions();

// Resolve the local credential gate while the workbench is restoring. The
// auxiliary-bar shell is created during restore, so waiting until
// `AfterRestored` leaves a visible empty Backboard panel even though checking
// the local config file is non-blocking.
registerWorkbenchContribution2(BackboardCredentialsContribution.ID, BackboardCredentialsContribution, WorkbenchPhase.BlockRestore);
