/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/changesTitleBarWidget.css';

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { IsAuxiliaryWindowContext, AuxiliaryBarVisibleContext } from '../../../../workbench/common/contextkeys.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Menus } from '../../../browser/menus.js';
import { SessionsWelcomeVisibleContext } from '../../../common/contextkeys.js';
import { logChangesViewToggle } from '../../../common/sessionsTelemetry.js';
import { RightWorkbenchCommandId } from '../../rightWorkbench/browser/rightWorkbench.js';

const TOGGLE_CHANGES_VIEW_ID = 'workbench.action.agentSessions.toggleChangesView';
const OPEN_CHANGES_VIEW_ID = 'workbench.action.agentSessions.openChangesInRightPanel';
const TOGGLE_SECONDARY_SIDEBAR_TOOLTIP = localize('toggleSecondarySidebarTooltip', "Toggle Right Panel Visibility");

const changesButtonIcon = registerIcon('agent-right-panel-changes', Codicon.gitCompare, localize('agentRightPanelChangesIcon', "Icon for opening the session changes view."));
const secondarySidebarToggleClosedIcon = registerIcon('agent-secondary-sidebar-toggle-closed', Codicon.layoutSidebarRightOff, localize('agentSecondarySidebarToggleClosedIcon', "Icon for the sessions secondary sidebar when closed."));
const secondarySidebarToggleOpenIcon = registerIcon('agent-secondary-sidebar-toggle-open', Codicon.layoutSidebarRight, localize('agentSecondarySidebarToggleOpenIcon', "Icon for the sessions secondary sidebar when open."));

/**
 * Registers the Changes view toggle action in the titlebar session toolbar.
 */
export class ChangesTitleBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.changesTitleBar';

	constructor() {
		super();

		this._register(MenuRegistry.appendMenuItem(Menus.SessionBarToolbar, {
			command: {
				id: TOGGLE_CHANGES_VIEW_ID,
				title: localize2('showRightPanel', "Show Right Panel"),
				tooltip: TOGGLE_SECONDARY_SIDEBAR_TOOLTIP,
				icon: secondarySidebarToggleClosedIcon,
				toggled: {
					condition: AuxiliaryBarVisibleContext,
					icon: secondarySidebarToggleOpenIcon,
					title: localize('hideRightPanel', "Hide Right Panel"),
					tooltip: TOGGLE_SECONDARY_SIDEBAR_TOOLTIP,
				},
			},
			group: 'navigation',
			order: 11, // After Environment (9) and Open Terminal (10)
			// NB: no IsAuxiliaryWindowContext gate — the floating toolbar only
			// renders in the sessions window, and that key spuriously flips true
			// when the right panel/editor opens, which would hide this toggle.
			when: SessionsWelcomeVisibleContext.toNegated(),
		}));

		// Same toggle in the title bar's right layout (next to the update button)
		// on the new-session screen, so the terminal and right-panel controls sit
		// in the top title-bar row before a session is created.
		this._register(MenuRegistry.appendMenuItem(Menus.TitleBarRightLayout, {
			command: {
				id: TOGGLE_CHANGES_VIEW_ID,
				title: localize2('showRightPanel', "Show Right Panel"),
				tooltip: TOGGLE_SECONDARY_SIDEBAR_TOOLTIP,
				icon: secondarySidebarToggleClosedIcon,
				toggled: {
					condition: AuxiliaryBarVisibleContext,
					icon: secondarySidebarToggleOpenIcon,
					title: localize('hideRightPanel', "Hide Right Panel"),
					tooltip: TOGGLE_SECONDARY_SIDEBAR_TOOLTIP,
				},
			},
			group: 'navigation',
			order: 3,
			// Exact complement of the SessionBarToolbar registration above: the
			// title bar carries this toggle only on the welcome/new-session screen
			// (where no session header exists); once a session is open the header
			// toolbar is its sole home, so the two rows never show duplicates.
			when: SessionsWelcomeVisibleContext,
		}));

		this._register(MenuRegistry.appendMenuItem(Menus.AuxiliaryBarTitle, {
			command: {
				id: OPEN_CHANGES_VIEW_ID,
				title: localize2('openChangesInRightPanel', "Changes"),
				tooltip: localize('openChangesInRightPanelTooltip', "Show Changes"),
				icon: changesButtonIcon,
			},
			group: 'navigation',
			order: 0,
			when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), SessionsWelcomeVisibleContext.toNegated()),
		}));
	}
}

// Register the toggle action
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: TOGGLE_CHANGES_VIEW_ID,
			title: localize2('showRightPanel', "Show Right Panel"),
			tooltip: TOGGLE_SECONDARY_SIDEBAR_TOOLTIP,
			icon: secondarySidebarToggleClosedIcon,
			toggled: {
				condition: AuxiliaryBarVisibleContext,
				icon: secondarySidebarToggleOpenIcon,
				title: localize('hideRightPanel', "Hide Right Panel"),
				tooltip: TOGGLE_SECONDARY_SIDEBAR_TOOLTIP,
			},
			precondition: IsAuxiliaryWindowContext.toNegated(),
		});
	}

	run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const commandService = accessor.get(ICommandService);
		const telemetryService = accessor.get(ITelemetryService);

		const isVisible = !layoutService.isVisible(Parts.AUXILIARYBAR_PART);

		if (isVisible) {
			void commandService.executeCommand(RightWorkbenchCommandId.OpenLauncherMode);
		} else {
			layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		}

		logChangesViewToggle(telemetryService, isVisible);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_CHANGES_VIEW_ID,
			title: localize2('openChangesInRightPanel', "Changes"),
			tooltip: localize('openChangesInRightPanelTooltip', "Show Changes"),
			icon: changesButtonIcon,
			precondition: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), SessionsWelcomeVisibleContext.toNegated()),
		});
	}

	run(accessor: ServicesAccessor): void {
		void accessor.get(ICommandService).executeCommand(RightWorkbenchCommandId.OpenReview);
	}
});
