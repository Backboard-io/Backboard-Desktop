/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../platform/registry/common/platform.js';

// --- Configuration
//
// Zen Mode is not offered in Backboard Studio: there is no command, keybinding
// or menu entry that can enter it (see the removed entrypoints below). The
// `zenMode.*` settings stay registered so the layout code that still reads them
// keeps resolving its defaults, and so re-enabling the feature is a matter of
// putting the entrypoints back.

(function registerZenModeConfiguration(): void {
	const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

	registry.registerConfiguration({
		'id': 'zenMode',
		'order': 9,
		'title': localize('zenModeConfigurationTitle', "Zen Mode"),
		'type': 'object',
		'properties': {
			'zenMode.fullScreen': {
				'type': 'boolean',
				'default': true,
				'description': localize('zenMode.fullScreen', "Controls whether turning on Zen Mode also puts the workbench into full screen mode.")
			},
			'zenMode.centerLayout': {
				'type': 'boolean',
				'default': true,
				'description': localize('zenMode.centerLayout', "Controls whether turning on Zen Mode also centers the layout.")
			},
			'zenMode.showTabs': {
				'type': 'string',
				'enum': ['multiple', 'single', 'none'],
				'description': localize('zenMode.showTabs', "Controls whether turning on Zen Mode should show multiple editor tabs, a single editor tab, or hide the editor title area completely."),
				'enumDescriptions': [
					localize('zenMode.showTabs.multiple', "Each editor is displayed as a tab in the editor title area."),
					localize('zenMode.showTabs.single', "The active editor is displayed as a single large tab in the editor title area."),
					localize('zenMode.showTabs.none', "The editor title area is not displayed."),
				],
				'default': 'multiple'
			},
			'zenMode.hideStatusBar': {
				'type': 'boolean',
				'default': true,
				'description': localize('zenMode.hideStatusBar', "Controls whether turning on Zen Mode also hides the status bar at the bottom of the workbench.")
			},
			'zenMode.hideActivityBar': {
				'type': 'boolean',
				'default': true,
				'description': localize('zenMode.hideActivityBar', "Controls whether turning on Zen Mode also hides the activity bar either at the left or right of the workbench.")
			},
			'zenMode.hideLineNumbers': {
				'type': 'boolean',
				'default': true,
				'description': localize('zenMode.hideLineNumbers', "Controls whether turning on Zen Mode also hides the editor line numbers.")
			},
			'zenMode.restore': {
				'type': 'boolean',
				'default': true,
				'description': localize('zenMode.restore', "Controls whether a window should restore to Zen Mode if it was exited in Zen Mode.")
			},
			'zenMode.silentNotifications': {
				'type': 'boolean',
				'default': true,
				'description': localize('zenMode.silentNotifications', "Controls whether notifications do not disturb mode should be enabled while in Zen Mode. If true, only error notifications will pop out.")
			}
		}
	});
})();

// --- Removed entrypoints
//
// The `workbench.action.toggleZenMode` action (Command Palette entry, Ctrl/Cmd+K Z
// keybinding and View > Appearance menu item), the `workbench.action.exitZenMode`
// Escape Escape keybinding, and the Zen Mode "Tab Bar" submenu used to be
// registered here. They are intentionally gone so Zen Mode is unreachable.
