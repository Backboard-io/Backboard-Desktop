/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import * as domStylesheetsJs from '../../../../base/browser/domStylesheets.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { DefaultStyleController, IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { RenderIndentGuides } from '../../../../base/browser/ui/tree/abstractTree.js';
import { ITreeElement, ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Iterable } from '../../../../base/common/iterator.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IListService, IWorkbenchObjectTreeOptions, WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { getListStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { editorBackground, focusBorder } from '../../../../platform/theme/common/colorRegistry.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { settingsHeaderForeground, settingsHeaderHoverForeground } from '../common/settingsEditorColorRegistry.js';
import { SettingsTreeFilter } from './settingsTree.js';
import { ISettingsEditorViewState, SearchResultModel, SettingsTreeElement, SettingsTreeGroupElement, SettingsTreeSettingElement } from './settingsTreeModels.js';

const $ = DOM.$;

export class TOCTreeModel {

	private _currentSearchModel: SearchResultModel | null = null;
	private _settingsTreeRoot!: SettingsTreeGroupElement;

	constructor(
		private _viewState: ISettingsEditorViewState,
		@IWorkbenchEnvironmentService private environmentService: IWorkbenchEnvironmentService
	) {
	}

	get settingsTreeRoot(): SettingsTreeGroupElement {
		return this._settingsTreeRoot;
	}

	set settingsTreeRoot(value: SettingsTreeGroupElement) {
		this._settingsTreeRoot = value;
		this.update();
	}

	get currentSearchModel(): SearchResultModel | null {
		return this._currentSearchModel;
	}

	set currentSearchModel(model: SearchResultModel | null) {
		this._currentSearchModel = model;
		this.update();
	}

	get children(): SettingsTreeElement[] {
		return this._settingsTreeRoot.children;
	}

	update(): void {
		if (this._settingsTreeRoot) {
			this.updateGroupCount(this._settingsTreeRoot);
		}
	}

	private updateGroupCount(group: SettingsTreeGroupElement): void {
		group.children.forEach(child => {
			if (child instanceof SettingsTreeGroupElement) {
				this.updateGroupCount(child);
			}
		});

		const childCount = group.children
			.filter(child => child instanceof SettingsTreeGroupElement)
			.reduce((acc, cur) => acc + (<SettingsTreeGroupElement>cur).count!, 0);

		group.count = childCount + this.getGroupCount(group);
	}

	private getGroupCount(group: SettingsTreeGroupElement): number {
		return group.children.filter(child => {
			if (!(child instanceof SettingsTreeSettingElement)) {
				return false;
			}

			if (this._currentSearchModel && !this._currentSearchModel.root.containsSetting(child.setting.key)) {
				return false;
			}

			// Check everything that the SettingsFilter checks except whether it's filtered by a category
			const isRemote = !!this.environmentService.remoteAuthority;
			return child.matchesScope(this._viewState.settingsTarget, isRemote) &&
				child.matchesAllTags(this._viewState.tagFilters) &&
				child.matchesAnyFeature(this._viewState.featureFilters) &&
				child.matchesAnyExtension(this._viewState.extensionFilters) &&
				child.matchesAnyId(this._viewState.idFilters);
		}).length;
	}
}

const TOC_ENTRY_TEMPLATE_ID = 'settings.toc.entry';

interface ITOCEntryTemplate {
	iconElement: HTMLElement;
	labelElement: HTMLElement;
	countElement: HTMLElement;
	elementDisposables: DisposableStore;
}

function getSettingsSectionIcon(element: SettingsTreeGroupElement): ThemeIcon {
	const section = `${element.id} ${element.label}`.toLowerCase();
	const editorSectionIcons: Record<string, ThemeIcon> = {
		'editor': Codicon.edit,
		'editor/cursor': Codicon.cursor,
		'editor/find': Codicon.search,
		'editor/font': Codicon.symbolText,
		'editor/format': Codicon.wand,
		'editor/diffEditor': Codicon.diff,
		'editor/multiDiffEditor': Codicon.diffMultiple,
		'editor/minimap': Codicon.map,
		'editor/suggestions': Codicon.lightbulb,
		'editor/files': Codicon.files,
	};
	const editorSectionIcon = editorSectionIcons[element.id];
	if (editorSectionIcon) {
		return editorSectionIcon;
	}

	const featureSectionIcons: Record<string, ThemeIcon> = {
		'features/accessibilitySignals': Codicon.bellDot,
		'features/accessibility': Codicon.person,
		'features/explorer': Codicon.files,
		'features/search': Codicon.search,
		'features/debug': Codicon.debugAlt,
		'features/testing': Codicon.beaker,
		'features/scm': Codicon.sourceControl,
		'features/extensions': Codicon.extensions,
		'features/terminal': Codicon.terminal,
		'features/task': Codicon.tasklist,
		'features/problems': Codicon.warning,
		'features/output': Codicon.output,
		'features/comments': Codicon.commentDiscussion,
		'features/remote': Codicon.remote,
		'features/timeline': Codicon.history,
		'features/notebook': Codicon.notebook,
		'features/mergeEditor': Codicon.merge,
		'features/issueReporter': Codicon.issues,
	};
	const featureSectionIcon = featureSectionIcons[element.id];
	if (featureSectionIcon) {
		return featureSectionIcon;
	}

	if (section.includes('commonly used')) {
		return Codicon.star;
	}
	if (section.includes('keyboard') || section.includes('keybinding')) {
		return Codicon.keyboard;
	}
	if (section.includes('text editor')) {
		return Codicon.edit;
	}
	if (section.includes('appearance') || section.includes('theme') || section.includes('color')) {
		return Codicon.symbolColor;
	}
	if (section.includes('provider') || section.includes('agent') || section.includes('chat')) {
		return Codicon.robot;
	}
	if (section.includes('source control') || section.includes('scm') || section.includes('git')) {
		return Codicon.sourceControl;
	}
	if (section.includes('connection') || section.includes('remote') || section.includes('network')) {
		return Codicon.plug;
	}
	if (section.includes('archive')) {
		return Codicon.archive;
	}
	if (section.includes('security')) {
		return Codicon.shield;
	}
	if (section.includes('window')) {
		return Codicon.window;
	}
	if (section.includes('workbench')) {
		return Codicon.layout;
	}
	if (section.includes('feature')) {
		return Codicon.sparkle;
	}
	if (section.includes('application')) {
		return Codicon.package;
	}
	if (section.includes('extension')) {
		return Codicon.extensions;
	}

	return Codicon.settingsGear;
}

export class TOCRenderer implements ITreeRenderer<SettingsTreeGroupElement, never, ITOCEntryTemplate> {

	templateId = TOC_ENTRY_TEMPLATE_ID;

	constructor(private readonly _hoverService: IHoverService) {
	}

	renderTemplate(container: HTMLElement): ITOCEntryTemplate {
		return {
			iconElement: DOM.append(container, $('.settings-toc-icon.codicon')),
			labelElement: DOM.append(container, $('.settings-toc-entry')),
			countElement: DOM.append(container, $('.settings-toc-count')),
			elementDisposables: new DisposableStore()
		};
	}

	renderElement(node: ITreeNode<SettingsTreeGroupElement>, index: number, template: ITOCEntryTemplate): void {
		template.elementDisposables.clear();

		const element = node.element;
		const count = element.count;
		const label = element.label;
		const icon = getSettingsSectionIcon(element);

		template.iconElement.className = `settings-toc-icon codicon codicon-${icon.id}`;
		template.labelElement.textContent = label;
		template.elementDisposables.add(this._hoverService.setupDelayedHover(template.labelElement, { content: label }));

		if (count) {
			template.countElement.textContent = ` (${count})`;
		} else {
			template.countElement.textContent = '';
		}
	}

	disposeTemplate(templateData: ITOCEntryTemplate): void {
		templateData.elementDisposables.dispose();
	}
}

class TOCTreeDelegate implements IListVirtualDelegate<SettingsTreeElement> {
	getTemplateId(element: SettingsTreeElement): string {
		return TOC_ENTRY_TEMPLATE_ID;
	}

	getHeight(element: SettingsTreeElement): number {
		return 32;
	}
}

export function createTOCIterator(model: TOCTreeModel | SettingsTreeGroupElement, tree: TOCTree): Iterable<ITreeElement<SettingsTreeGroupElement>> {
	const groupChildren = <SettingsTreeGroupElement[]>model.children.filter(c => c instanceof SettingsTreeGroupElement);

	return Iterable.map(groupChildren, g => {
		const hasGroupChildren = g.children.some(c => c instanceof SettingsTreeGroupElement);

		return {
			element: g,
			collapsed: undefined,
			collapsible: hasGroupChildren,
			children: g instanceof SettingsTreeGroupElement ?
				createTOCIterator(g, tree) :
				undefined
		};
	});
}

class SettingsAccessibilityProvider implements IListAccessibilityProvider<SettingsTreeGroupElement> {
	getWidgetAriaLabel(): string {
		return localize({
			key: 'settingsTOC',
			comment: ['A label for the table of contents for the full settings list']
		},
			"Settings Table of Contents");
	}

	getAriaLabel(element: SettingsTreeElement): string {
		if (!element) {
			return '';
		}

		if (element instanceof SettingsTreeGroupElement) {
			return localize('groupRowAriaLabel', "{0}, group", element.label);
		}

		return '';
	}

	getAriaLevel(element: SettingsTreeGroupElement): number {
		let i = 1;
		while (element instanceof SettingsTreeGroupElement && element.parent) {
			i++;
			element = element.parent;
		}

		return i;
	}
}

export class TOCTree extends WorkbenchObjectTree<SettingsTreeGroupElement> {
	constructor(
		container: HTMLElement,
		viewState: ISettingsEditorViewState,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IListService listService: IListService,
		@IConfigurationService configurationService: IConfigurationService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		// test open mode

		const filter = instantiationService.createInstance(SettingsTreeFilter, viewState, false);
		const options: IWorkbenchObjectTreeOptions<SettingsTreeGroupElement, void> = {
			filter,
			multipleSelectionSupport: false,
			identityProvider: {
				getId(e) {
					return e.id;
				}
			},
			styleController: id => new DefaultStyleController(domStylesheetsJs.createStyleSheet(container), id),
			accessibilityProvider: instantiationService.createInstance(SettingsAccessibilityProvider),
			collapseByDefault: true,
			horizontalScrolling: false,
			hideTwistiesOfChildlessElements: true,
			renderIndentGuides: RenderIndentGuides.None
		};

		super(
			'SettingsTOC',
			container,
			new TOCTreeDelegate(),
			[new TOCRenderer(hoverService)],
			options,
			instantiationService,
			contextKeyService,
			listService,
			configurationService,
		);

		this.style(getListStyles({
			listBackground: editorBackground,
			listFocusOutline: focusBorder,
			listActiveSelectionBackground: editorBackground,
			listActiveSelectionForeground: settingsHeaderForeground,
			listFocusAndSelectionBackground: editorBackground,
			listFocusAndSelectionForeground: settingsHeaderForeground,
			listFocusBackground: editorBackground,
			listFocusForeground: settingsHeaderHoverForeground,
			listHoverForeground: settingsHeaderHoverForeground,
			listHoverBackground: editorBackground,
			listInactiveSelectionBackground: editorBackground,
			listInactiveSelectionForeground: settingsHeaderForeground,
			listInactiveFocusBackground: editorBackground,
			listInactiveFocusOutline: editorBackground,
			treeIndentGuidesStroke: undefined,
			treeInactiveIndentGuidesStroke: undefined
		}));
	}
}
