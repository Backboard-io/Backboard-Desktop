/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerAction2 } from '../../platform/actions/common/actions.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { EnvironmentTitleBarContribution } from '../browser/actions/environmentTitleBarWidget.js';
import { OpenSessionInVSCodeAction, OpenInVSCodeWidgetContribution, OpenJarvisWindowAction, OpenOptimusWindowAction, OpenVSCodeWindowAction, OpenWorkspaceInVSCodeAction } from './actions/vscodeActions.js';

// Actions
(function registerActions(): void {
	registerAction2(OpenSessionInVSCodeAction);
	registerAction2(OpenWorkspaceInVSCodeAction);
	registerAction2(OpenVSCodeWindowAction);
	registerAction2(OpenOptimusWindowAction);
	registerAction2(OpenJarvisWindowAction);
})();

(function registerWorkbenchContributions(): void {
	registerWorkbenchContribution2(OpenInVSCodeWidgetContribution.ID, OpenInVSCodeWidgetContribution, WorkbenchPhase.BlockRestore);
	registerWorkbenchContribution2(EnvironmentTitleBarContribution.ID, EnvironmentTitleBarContribution, WorkbenchPhase.BlockRestore);
})();
