/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/editorMarketplaceView.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainer, ViewContainerLocation, Extensions as ViewExtensions } from '../../../common/views.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { BackboardMarketplaceViewContainerId, BackboardMarketplaceViewId } from './chat.js';
import { SkillsLibraryController } from './widget/input/skillsLibrary.js';

class EditorMarketplaceViewPane extends ViewPane {

	private readonly marketplace = this._register(new MutableDisposable());
	private bodyContainer: HTMLElement | undefined;

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService protected override instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('backboard-marketplace-view');
		this.bodyContainer = dom.append(container, dom.$('.backboard-marketplace-view-body'));
		this.marketplace.value = this.instantiationService.createInstance(SkillsLibraryController).renderEmbeddedMarketplace(this.bodyContainer);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.bodyContainer) {
			this.bodyContainer.style.height = `${height}px`;
			this.bodyContainer.style.width = `${width}px`;
		}
	}
}

const marketplaceViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: BackboardMarketplaceViewContainerId,
	title: localize2('backboardMarketplace.viewContainer', "Marketplace"),
	icon: Codicon.extensions,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [BackboardMarketplaceViewContainerId, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: BackboardMarketplaceViewContainerId,
	order: 6,
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: BackboardMarketplaceViewId,
	containerIcon: marketplaceViewContainer.icon,
	containerTitle: marketplaceViewContainer.title.value,
	singleViewPaneContainerTitle: marketplaceViewContainer.title.value,
	name: localize2('backboardMarketplace.view', "Marketplace"),
	canToggleVisibility: true,
	canMoveView: true,
	ctorDescriptor: new SyncDescriptor(EditorMarketplaceViewPane),
}], marketplaceViewContainer);
