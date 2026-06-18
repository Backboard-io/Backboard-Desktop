/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, WindowEnablement } from '../../../../workbench/common/views.js';
import { IsPhoneLayoutContext } from '../../../common/contextkeys.js';
import { SESSIONS_BROWSER_VIEW_CONTAINER_ID, SESSIONS_BROWSER_VIEW_ID, SessionsBrowserViewPane } from './sessionBrowserPanel.js';
import { SessionBrowserViewController } from './sessionBrowserView.js';

const browserViewIcon = registerIcon('sessions-browser-view-icon', Codicon.globe, localize2('sessionsBrowserViewIcon', 'View icon of the browser view in the sessions window.').value);

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
