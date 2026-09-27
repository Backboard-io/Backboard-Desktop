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
import { MultipleSessionsVisibleContext, SessionSidePanelVisibleContext, SessionsWelcomeVisibleContext } from '../../../common/contextkeys.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { logChangesViewToggle } from '../../../common/sessionsTelemetry.js';
import { RightWorkbenchCommandId } from '../../rightWorkbench/browser/rightWorkbench.js';

const TOGGLE_CHANGES_VIEW_ID = 'workbench.action.agentSessions.toggleChangesView';
const OPEN_CHANGES_VIEW_ID = 'workbench.action.agentSessions.openChangesInRightPanel';
const TOGGLE_SECONDARY_SIDEBAR_TOOLTIP = localize('toggleSecondarySidebarTooltip', "Toggle Right Panel Visibility");

const changesButtonIcon = registerIcon('agent-right-panel-changes', Codicon.gitCompare, localize('agentRightPanelChangesIcon', "Icon for opening the session changes view."));
const secondarySidebarToggleClosedIcon = registerIcon('agent-secondary-sidebar-toggle-closed', Codicon.layoutSidebarRightOff, localize('agentSecondarySidebarToggleClosedIcon', "Icon for the sessions secondary sidebar when closed."));
const secondarySidebarToggleOpenIcon = registerIcon('agent-secondary-sidebar-toggle-open', Codicon.layoutSidebarRight, localize('agentSecondarySidebarToggleOpenIcon', "Icon for the sessions secondary sidebar when open."));

/**
 * The right panel is the auxiliary bar for a single session, and each
 * column's own panel while the grid is split (evaluated in the column's
 * scoped context, so every header shows its own column's state).
 */
const RightPanelVisibleCondition = ContextKeyExpr.or(
	ContextKeyExpr.and(MultipleSessionsVisibleContext.toNegated(), AuxiliaryBarVisibleContext),
	ContextKeyExpr.and(MultipleSessionsVisibleContext, SessionSidePanelVisibleContext),
)!;

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
					condition: RightPanelVisibleCondition,
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
			// Keep the toggle mounted while the panel is open too, so closing or
			// switching sessions never removes the way back into the panel.
			when: SessionsWelcomeVisibleContext.toNegated(),
		}));

		// Same toggle in the new-chat page's own top-right slot, so the terminal
		// and right-panel controls sit above the composer before a session is
		// created. The floating SessionBarToolbar above only mounts once the
		// session exists (`isCreated`), so the two never show duplicates.
		this._register(MenuRegistry.appendMenuItem(Menus.NewSessionToolbar, {
			command: {
				id: TOGGLE_CHANGES_VIEW_ID,
				title: localize2('showRightPanel', "Show Right Panel"),
				tooltip: TOGGLE_SECONDARY_SIDEBAR_TOOLTIP,
				icon: secondarySidebarToggleClosedIcon,
				toggled: {
					condition: RightPanelVisibleCondition,
					icon: secondarySidebarToggleOpenIcon,
					title: localize('hideRightPanel', "Hide Right Panel"),
					tooltip: TOGGLE_SECONDARY_SIDEBAR_TOOLTIP,
				},
			},
			group: 'navigation',
			order: 11, // Same order as in the session toolbar
			when: SessionsWelcomeVisibleContext.toNegated(),
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
				condition: RightPanelVisibleCondition,
				icon: secondarySidebarToggleOpenIcon,
				title: localize('hideRightPanel', "Hide Right Panel"),
				tooltip: TOGGLE_SECONDARY_SIDEBAR_TOOLTIP,
			},
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const commandService = accessor.get(ICommandService);
		const telemetryService = accessor.get(ITelemetryService);
		const sessionsPartService = accessor.get(ISessionsPartService);

		if (sessionsPartService.isSplit) {
			// Toggle the active column's own panel. Header toolbars activate their
			// column before running, so this is the column that was clicked.
			const panel = sessionsPartService.getSidePanel(accessor.get(ISessionsService).activeSession.get()?.sessionId);
			const show = !panel || !sessionsPartService.isSidePanelVisible(panel);
			if (show) {
				void commandService.executeCommand(RightWorkbenchCommandId.OpenLauncherMode, { preserveActiveTab: true });
			} else {
				sessionsPartService.setSidePanelVisible(panel, false);
			}
			logChangesViewToggle(telemetryService, show);
			return;
		}

		const isVisible = !layoutService.isVisible(Parts.AUXILIARYBAR_PART);

		if (isVisible) {
			// Reopen onto the tab the user left: forcing the launcher here
			// would flash the restored surface (e.g. a native browser page)
			// and then tear it down.
			void commandService.executeCommand(RightWorkbenchCommandId.OpenLauncherMode, { preserveActiveTab: true });
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
