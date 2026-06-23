/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { BrowserViewCommandId } from '../../../../platform/browserView/common/browserView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsAuxiliaryWindowContext } from '../../../../workbench/common/contextkeys.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, WindowEnablement } from '../../../../workbench/common/views.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../browser/menus.js';
import { IsPhoneLayoutContext, SessionsWelcomeVisibleContext } from '../../../common/contextkeys.js';
import { SESSIONS_BROWSER_VIEW_CONTAINER_ID, SESSIONS_BROWSER_VIEW_ID, SessionsBrowserViewPane } from './sessionBrowserPanel.js';
import { SessionBrowserViewController } from './sessionBrowserView.js';

const browserViewIcon = registerIcon('sessions-browser-view-icon', Codicon.globe, localize2('sessionsBrowserViewIcon', 'View icon of the browser view in the sessions window.').value);
const BrowserEditorOpenContext = ContextKeyExpr.has('browserEditorOpen');

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

const browserViewContainer = viewContainerRegistry.registerViewContainer({
	id: SESSIONS_BROWSER_VIEW_CONTAINER_ID,
	title: localize2('browser', "Browser"),
	icon: browserViewIcon,
	order: 12,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SESSIONS_BROWSER_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: SESSIONS_BROWSER_VIEW_CONTAINER_ID,
	hideIfEmpty: false,
	openCommandActionDescriptor: {
		id: SESSIONS_BROWSER_VIEW_CONTAINER_ID,
		title: localize2('browser', "Browser"),
		mnemonicTitle: localize({ key: 'miBrowser', comment: ['&& denotes a mnemonic'] }, "Bro&&wser"),
		order: 2
	},
	windowEnablement: WindowEnablement.Sessions,
}, ViewContainerLocation.AuxiliaryBar);

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

viewsRegistry.registerViews([{
	id: SESSIONS_BROWSER_VIEW_ID,
	name: localize2('browser', "Browser"),
	containerIcon: browserViewIcon,
	ctorDescriptor: new SyncDescriptor(SessionsBrowserViewPane),
	canToggleVisibility: false,
	canMoveView: false,
	when: ContextKeyExpr.and(IsPhoneLayoutContext.negate()),
	windowEnablement: WindowEnablement.Sessions,
}], browserViewContainer);

registerWorkbenchContribution2(SessionBrowserViewController.ID, SessionBrowserViewController, WorkbenchPhase.AfterRestored);

class AddBrowserAreaScreenshotToChatFromSessionAction extends Action2 {

	static readonly ID = 'workbench.action.sessions.addBrowserAreaScreenshotToChat';

	constructor() {
		super({
			id: AddBrowserAreaScreenshotToChatFromSessionAction.ID,
			title: localize2('sessions.browser.addAreaScreenshotToChat', "Add Area Screenshot to Chat"),
			icon: Codicon.screenFull,
			precondition: BrowserEditorOpenContext,
			menu: {
				id: Menus.TitleBarRightLayout,
				group: 'navigation',
				order: -1,
				when: ContextKeyExpr.and(
					IsAuxiliaryWindowContext.toNegated(),
					SessionsWelcomeVisibleContext.toNegated(),
					IsPhoneLayoutContext.negate()
				),
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const browserViewService = accessor.get(IBrowserViewWorkbenchService);
		const commandService = accessor.get(ICommandService);
		const browserViews = browserViewService.getContextualBrowserViews();
		const activeEditor = editorService.activeEditor;

		if (!(activeEditor instanceof BrowserEditorInput) || !browserViews.has(activeEditor.id)) {
			const browserInput = browserViews.values().next().value;
			if (!browserInput) {
				return;
			}

			await editorService.openEditor(browserInput);
		}

		await commandService.executeCommand(BrowserViewCommandId.AddAreaScreenshotToChat);
	}
}

registerAction2(AddBrowserAreaScreenshotToChatFromSessionAction);
