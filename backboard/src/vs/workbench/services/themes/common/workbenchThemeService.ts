/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import { IColorTheme, IThemeService, IFileIconTheme, IProductIconTheme } from '../../../../platform/theme/common/themeService.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { isBoolean, isString } from '../../../../base/common/types.js';
import { IconContribution, IconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';

export const IWorkbenchThemeService = refineServiceDecorator<IThemeService, IWorkbenchThemeService>(IThemeService);

export const THEME_SCOPE_OPEN_PAREN = '[';
export const THEME_SCOPE_CLOSE_PAREN = ']';
export const THEME_SCOPE_WILDCARD = '*';

export const themeScopeRegex = /\[(.+?)\]/g;

export enum ThemeSettings {
	COLOR_THEME = 'workbench.colorTheme',
	FILE_ICON_THEME = 'workbench.iconTheme',
	PRODUCT_ICON_THEME = 'workbench.productIconTheme',
	COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations',
	TOKEN_COLOR_CUSTOMIZATIONS = 'editor.tokenColorCustomizations',
	SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS = 'editor.semanticTokenColorCustomizations',

	PREFERRED_DARK_THEME = 'workbench.preferredDarkColorTheme',
	PREFERRED_LIGHT_THEME = 'workbench.preferredLightColorTheme',
	PREFERRED_HC_DARK_THEME = 'workbench.preferredHighContrastColorTheme', /* id kept for compatibility reasons */
	PREFERRED_HC_LIGHT_THEME = 'workbench.preferredHighContrastLightColorTheme',
	DETECT_COLOR_SCHEME = 'window.autoDetectColorScheme',
	DETECT_HC = 'window.autoDetectHighContrast',

	SYSTEM_COLOR_THEME = 'window.systemColorTheme'
}

export namespace ThemeSettingDefaults {
	export const COLOR_THEME_DARK = 'Backboard Obsidian';
	export const COLOR_THEME_LIGHT = 'Backboard Porcelain';
	export const COLOR_THEME_HC_DARK = 'Default High Contrast';
	export const COLOR_THEME_HC_LIGHT = 'Default High Contrast Light';

	export const FILE_ICON_THEME = 'vs-seti';
	export const PRODUCT_ICON_THEME = 'Default';
}

/**
 * Migrates legacy theme settings IDs to their current equivalents.
 * Theme IDs were simplified: "Default" prefix was removed from built-in themes,
 * and "Experimental" prefix was replaced when VS Code themes became GA.
 */
export function migrateThemeSettingsId(settingsId: string): string {
	switch (settingsId) {
		case 'Default Dark Modern': return 'Dark Modern';
		case 'Default Light Modern': return 'Light Modern';
		case 'Default Dark+': return 'Dark+';
		case 'Default Light+': return 'Light+';
		case 'Experimental Dark':
		case 'VS Code Dark':
			return ThemeSettingDefaults.COLOR_THEME_DARK;
		case 'Experimental Light':
		case 'VS Code Light':
			return ThemeSettingDefaults.COLOR_THEME_LIGHT;
	}
	return settingsId;
}

export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#383a49',
	'activityBar.activeBorder': '#969696',
	'activityBar.background': '#101010',
	'activityBar.border': '#202020',
	'activityBar.foreground': '#E5E5E5',
	'activityBar.inactiveForeground': '#767676',
	'activityBarBadge.background': '#626262',
	'activityBarBadge.foreground': '#FFFFFF',
	'badge.background': '#616161',
	'badge.foreground': '#F8F8F8',
	'button.background': '#626262',
	'button.border': '#FFFFFF12',
	'button.foreground': '#FFFFFF',
	'button.hoverBackground': '#707070',
	'button.secondaryBackground': '#232323',
	'button.secondaryForeground': '#D8D8D8',
	'button.secondaryHoverBackground': '#2A2A2A',
	'chat.slashCommandBackground': '#26477866',
	'chat.slashCommandForeground': '#85B6FF',
	'chat.editedFileForeground': '#E2C08D',
	'checkbox.background': '#313131',
	'checkbox.border': '#3C3C3C',
	'debugToolBar.background': '#181818',
	'descriptionForeground': '#999999',
	'dropdown.background': '#1A1A1A',
	'dropdown.border': '#343434',
	'dropdown.foreground': '#E8E8E8',
	'dropdown.listBackground': '#1A1A1A',
	'editor.background': '#0D0D0D',
	'editor.findMatchBackground': '#9E6A03',
	'editor.foreground': '#D8D8D8',
	'editor.inactiveSelectionBackground': '#3A3D41',
	'editor.selectionHighlightBackground': '#ADD6FF26',
	'editorGroup.border': '#252525',
	'editorGroupHeader.tabsBackground': '#121212',
	'editorGroupHeader.tabsBorder': '#252525',
	'editorGutter.addedBackground': '#2EA043',
	'editorGutter.deletedBackground': '#F85149',
	'editorGutter.modifiedBackground': '#0078D4',
	'editorIndentGuide.activeBackground1': '#707070',
	'editorIndentGuide.background1': '#404040',
	'editorLineNumber.activeForeground': '#CCCCCC',
	'editorLineNumber.foreground': '#6E7681',
	'editorOverviewRuler.border': '#010409',
	'editorWidget.background': '#1A1A1A',
	'errorForeground': '#F85149',
	'focusBorder': '#969696B3',
	'foreground': '#D8D8D8',
	'icon.foreground': '#B0B0B0',
	'input.background': '#1A1A1A',
	'input.border': '#343434',
	'input.foreground': '#E8E8E8',
	'input.placeholderForeground': '#777777',
	'inputOption.activeBackground': '#2489DB82',
	'inputOption.activeBorder': '#2488DB',
	'keybindingLabel.foreground': '#CCCCCC',
	'list.activeSelectionIconForeground': '#FFF',
	'list.dropBackground': '#383B3D',
	'menu.background': '#1A1A1A',
	'menu.border': '#343434',
	'menu.foreground': '#D8D8D8',
	'menu.selectionBackground': '#292929',
	'menu.separatorBackground': '#343434',
	'notificationCenterHeader.background': '#1C1C1C',
	'notificationCenterHeader.foreground': '#D8D8D8',
	'notifications.background': '#1A1A1A',
	'notifications.border': '#343434',
	'notifications.foreground': '#D8D8D8',
	'panel.background': '#121212',
	'panel.border': '#252525',
	'panelInput.border': '#252525',
	'panelTitle.activeBorder': '#969696',
	'panelTitle.activeForeground': '#E8E8E8',
	'panelTitle.inactiveForeground': '#909090',
	'peekViewEditor.background': '#1F1F1F',
	'peekViewEditor.matchHighlightBackground': '#BB800966',
	'peekViewResult.background': '#1F1F1F',
	'peekViewResult.matchHighlightBackground': '#BB800966',
	'pickerGroup.border': '#3C3C3C',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#0078D4',
	'quickInput.background': '#222222',
	'quickInput.foreground': '#CCCCCC',
	'settings.dropdownBackground': '#313131',
	'settings.dropdownBorder': '#3C3C3C',
	'settings.headerForeground': '#FFFFFF',
	'settings.modifiedItemIndicator': '#BB800966',
	'sideBar.background': '#121212',
	'sideBar.border': '#252525',
	'sideBar.foreground': '#D4D4D4',
	'sideBarSectionHeader.background': '#121212',
	'sideBarSectionHeader.border': '#00000000',
	'sideBarSectionHeader.foreground': '#CFCFCF',
	'sideBarTitle.foreground': '#E8E8E8',
	'statusBar.background': '#111111',
	'statusBar.border': '#202020',
	'statusBar.debuggingBackground': '#0078D4',
	'statusBar.debuggingForeground': '#FFFFFF',
	'statusBar.focusBorder': '#0078D4',
	'statusBar.foreground': '#CCCCCC',
	'statusBar.noFolderBackground': '#1F1F1F',
	'statusBarItem.focusBorder': '#0078D4',
	'statusBarItem.prominentBackground': '#6E768166',
	'statusBarItem.remoteBackground': '#0078D4',
	'statusBarItem.remoteForeground': '#FFFFFF',
	'tab.activeBackground': '#0D0D0D',
	'tab.activeBorder': '#0D0D0D',
	'tab.activeBorderTop': '#00000000',
	'tab.activeForeground': '#F2F2F2',
	'tab.border': '#252525',
	'tab.hoverBackground': '#1A1A1A',
	'tab.inactiveBackground': '#121212',
	'tab.inactiveForeground': '#969696',
	'tab.lastPinnedBorder': '#ccc3',
	'tab.selectedBackground': '#222222',
	'tab.selectedBorderTop': '#6caddf',
	'tab.selectedForeground': '#ffffffa0',
	'tab.unfocusedActiveBorder': '#1F1F1F',
	'tab.unfocusedActiveBorderTop': '#2B2B2B',
	'tab.unfocusedHoverBackground': '#1F1F1F',
	'terminal.foreground': '#CCCCCC',
	'terminal.inactiveSelectionBackground': '#3A3D41',
	'terminal.tab.activeBorder': '#0078D4',
	'textBlockQuote.background': '#2B2B2B',
	'textBlockQuote.border': '#616161',
	'textCodeBlock.background': '#2B2B2B',
	'textLink.activeForeground': '#4daafc',
	'textLink.foreground': '#4daafc',
	'textPreformat.background': '#3C3C3C',
	'textPreformat.foreground': '#D0D0D0',
	'textSeparator.foreground': '#21262D',
	'titleBar.activeBackground': '#111111',
	'titleBar.activeForeground': '#D8D8D8',
	'titleBar.border': '#202020',
	'titleBar.inactiveBackground': '#111111',
	'titleBar.inactiveForeground': '#767676',
	'welcomePage.progress.foreground': '#0078D4',
	'welcomePage.tileBackground': '#2B2B2B',
	'widget.border': '#313131'
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#D4DBE2',
	'activityBar.activeBorder': '#426A8C',
	'activityBar.background': '#ECEFF2',
	'activityBar.border': '#D8DDE3',
	'activityBar.foreground': '#24282D',
	'activityBar.inactiveForeground': '#737D87',
	'activityBarBadge.background': '#426A8C',
	'activityBarBadge.foreground': '#FFFFFF',
	'badge.background': '#CCCCCC',
	'badge.foreground': '#3B3B3B',
	'button.background': '#343C44',
	'button.border': '#252C33',
	'button.foreground': '#FFFFFF',
	'button.hoverBackground': '#252C33',
	'button.secondaryBackground': '#E9EDF1',
	'button.secondaryForeground': '#303840',
	'button.secondaryHoverBackground': '#DDE3E8',
	'chat.slashCommandBackground': '#ADCEFF7A',
	'chat.slashCommandForeground': '#26569E',
	'chat.editedFileForeground': '#895503',
	'checkbox.background': '#FFFFFF',
	'checkbox.border': '#9AA5AF',
	'descriptionForeground': '#68727D',
	'diffEditor.unchangedRegionBackground': '#f8f8f8',
	'dropdown.background': '#FFFFFF',
	'dropdown.border': '#CBD2D9',
	'dropdown.foreground': '#24282D',
	'dropdown.listBackground': '#FFFFFF',
	'editor.background': '#FFFFFF',
	'editor.foreground': '#24282D',
	'editor.inactiveSelectionBackground': '#E5EBF1',
	'editor.selectionHighlightBackground': '#ADD6FF80',
	'editorGroup.border': '#D8DDE3',
	'editorGroupHeader.tabsBackground': '#EEF1F4',
	'editorGroupHeader.tabsBorder': '#D8DDE3',
	'editorGutter.addedBackground': '#2EA043',
	'editorGutter.deletedBackground': '#F85149',
	'editorGutter.modifiedBackground': '#005FB8',
	'editorIndentGuide.activeBackground1': '#939393',
	'editorIndentGuide.background1': '#D3D3D3',
	'editorLineNumber.activeForeground': '#171184',
	'editorLineNumber.foreground': '#6E7681',
	'editorOverviewRuler.border': '#E5E5E5',
	'editorSuggestWidget.background': '#F7F8F9',
	'editorWidget.background': '#F7F8F9',
	'errorForeground': '#F85149',
	'focusBorder': '#426A8C',
	'foreground': '#24282D',
	'icon.foreground': '#626C76',
	'input.background': '#FFFFFF',
	'input.border': '#CBD2D9',
	'input.foreground': '#24282D',
	'input.placeholderForeground': '#8A949E',
	'inputOption.activeBackground': '#426A8C1F',
	'inputOption.activeBorder': '#426A8C',
	'inputOption.activeForeground': '#263A4C',
	'keybindingLabel.foreground': '#3B3B3B',
	'list.activeSelectionBackground': '#DCE7EF',
	'list.activeSelectionForeground': '#243646',
	'list.activeSelectionIconForeground': '#315F86',
	'list.focusAndSelectionOutline': '#426A8C',
	'list.hoverBackground': '#E9EDF1',
	'menu.border': '#CBD2D9',
	'menu.selectionBackground': '#DCE7EF',
	'menu.selectionForeground': '#243646',
	'notebook.cellBorderColor': '#E5E5E5',
	'notebook.selectedCellBackground': '#C8DDF150',
	'notificationCenterHeader.background': '#F3F5F7',
	'notificationCenterHeader.foreground': '#24282D',
	'notifications.background': '#FFFFFF',
	'notifications.border': '#CBD2D9',
	'notifications.foreground': '#24282D',
	'panel.background': '#F3F5F7',
	'panel.border': '#D8DDE3',
	'panelInput.border': '#D8DDE3',
	'panelTitle.activeBorder': '#426A8C',
	'panelTitle.activeForeground': '#24282D',
	'panelTitle.inactiveForeground': '#737D87',
	'peekViewEditor.matchHighlightBackground': '#BB800966',
	'peekViewResult.background': '#FFFFFF',
	'peekViewResult.matchHighlightBackground': '#BB800966',
	'pickerGroup.border': '#E5E5E5',
	'pickerGroup.foreground': '#8B949E',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#426A8C',
	'quickInput.background': '#FFFFFF',
	'quickInput.foreground': '#24282D',
	'searchEditor.textInputBorder': '#CECECE',
	'settings.dropdownBackground': '#FFFFFF',
	'settings.dropdownBorder': '#CECECE',
	'settings.headerForeground': '#1F1F1F',
	'settings.modifiedItemIndicator': '#BB800966',
	'settings.numberInputBorder': '#CECECE',
	'settings.textInputBorder': '#CECECE',
	'sideBar.background': '#F3F5F7',
	'sideBar.border': '#D8DDE3',
	'sideBar.foreground': '#303840',
	'sideBarSectionHeader.background': '#F3F5F7',
	'sideBarSectionHeader.border': '#00000000',
	'sideBarSectionHeader.foreground': '#39434D',
	'sideBarTitle.foreground': '#24282D',
	'statusBar.background': '#EEF1F4',
	'statusBar.border': '#D8DDE3',
	'statusBar.debuggingBackground': '#FD716C',
	'statusBar.debuggingForeground': '#000000',
	'statusBar.focusBorder': '#426A8C',
	'statusBar.foreground': '#59646E',
	'statusBar.noFolderBackground': '#EEF1F4',
	'statusBarItem.compactHoverBackground': '#CCCCCC',
	'statusBarItem.errorBackground': '#C72E0F',
	'statusBarItem.focusBorder': '#005FB8',
	'statusBarItem.hoverBackground': '#B8B8B850',
	'statusBarItem.prominentBackground': '#6E768166',
	'statusBarItem.remoteBackground': '#DCE7EF',
	'statusBarItem.remoteForeground': '#243646',
	'tab.activeBackground': '#FFFFFF',
	'tab.activeBorder': '#FFFFFF',
	'tab.activeBorderTop': '#426A8C',
	'tab.activeForeground': '#24282D',
	'tab.border': '#D8DDE3',
	'tab.hoverBackground': '#F7F8F9',
	'tab.inactiveBackground': '#EEF1F4',
	'tab.inactiveForeground': '#737D87',
	'tab.lastPinnedBorder': '#D4D4D4',
	'tab.selectedBackground': '#ffffffa5',
	'tab.selectedBorderTop': '#68a3da',
	'tab.selectedForeground': '#333333b3',
	'tab.unfocusedActiveBorder': '#F8F8F8',
	'tab.unfocusedActiveBorderTop': '#E5E5E5',
	'tab.unfocusedHoverBackground': '#F8F8F8',
	'terminal.foreground': '#303840',
	'terminal.inactiveSelectionBackground': '#E5EBF1',
	'terminal.tab.activeBorder': '#426A8C',
	'terminalCursor.foreground': '#315F86',
	'textBlockQuote.background': '#F3F5F7',
	'textBlockQuote.border': '#CCD3DA',
	'textCodeBlock.background': '#F1F3F5',
	'textLink.activeForeground': '#214965',
	'textLink.foreground': '#315F86',
	'textPreformat.background': '#0000001F',
	'textPreformat.foreground': '#3B3B3B',
	'textSeparator.foreground': '#21262D',
	'titleBar.activeBackground': '#EEF1F4',
	'titleBar.activeForeground': '#303840',
	'titleBar.border': '#D8DDE3',
	'titleBar.inactiveBackground': '#EEF1F4',
	'titleBar.inactiveForeground': '#858F98',
	'welcomePage.tileBackground': '#F3F5F7',
	'widget.border': '#D8DDE3'
};

export interface IWorkbenchTheme {
	readonly id: string;
	readonly label: string;
	readonly extensionData?: ExtensionData;
	readonly description?: string;
	readonly settingsId: string | null;
}

export interface IWorkbenchColorTheme extends IWorkbenchTheme, IColorTheme {
	readonly settingsId: string;
	readonly tokenColors: ITextMateThemingRule[];
}

export interface IColorMap {
	[id: string]: Color;
}

export interface IWorkbenchFileIconTheme extends IWorkbenchTheme, IFileIconTheme {
}

export interface IWorkbenchProductIconTheme extends IWorkbenchTheme, IProductIconTheme {
	readonly settingsId: string;

	getIcon(icon: IconContribution): IconDefinition | undefined;
}

export type ThemeSettingTarget = ConfigurationTarget | undefined | 'auto' | 'preview';


export interface IWorkbenchThemeService extends IThemeService {
	readonly _serviceBrand: undefined;
	setColorTheme(themeId: string | undefined | IWorkbenchColorTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchColorTheme | null>;
	getColorTheme(): IWorkbenchColorTheme;
	getColorThemes(): Promise<IWorkbenchColorTheme[]>;
	getMarketplaceColorThemes(publisher: string, name: string, version: string): Promise<IWorkbenchColorTheme[]>;
	readonly onDidColorThemeChange: Event<IWorkbenchColorTheme>;

	getPreferredColorScheme(): ColorScheme | undefined;

	setFileIconTheme(iconThemeId: string | undefined | IWorkbenchFileIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchFileIconTheme>;
	getFileIconTheme(): IWorkbenchFileIconTheme;
	getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]>;
	getMarketplaceFileIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchFileIconTheme[]>;
	readonly onDidFileIconThemeChange: Event<IWorkbenchFileIconTheme>;

	setProductIconTheme(iconThemeId: string | undefined | IWorkbenchProductIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchProductIconTheme>;
	getProductIconTheme(): IWorkbenchProductIconTheme;
	getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]>;
	getMarketplaceProductIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchProductIconTheme[]>;
	readonly onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme>;
}

export interface IThemeScopedColorCustomizations {
	[colorId: string]: string;
}

export interface IColorCustomizations {
	[colorIdOrThemeScope: string]: IThemeScopedColorCustomizations | string;
}

export interface IThemeScopedTokenColorCustomizations {
	[groupId: string]: ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface ITokenColorCustomizations {
	[groupIdOrThemeScope: string]: IThemeScopedTokenColorCustomizations | ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface IThemeScopedSemanticTokenColorCustomizations {
	[styleRule: string]: ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface ISemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedSemanticTokenColorCustomizations | ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface IThemeScopedExperimentalSemanticTokenColorCustomizations {
	[themeScope: string]: ISemanticTokenRules | undefined;
}

export interface IExperimentalSemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedExperimentalSemanticTokenColorCustomizations | ISemanticTokenRules | undefined;
}

export type IThemeScopedCustomizations =
	IThemeScopedColorCustomizations
	| IThemeScopedTokenColorCustomizations
	| IThemeScopedExperimentalSemanticTokenColorCustomizations
	| IThemeScopedSemanticTokenColorCustomizations;

export type IThemeScopableCustomizations =
	IColorCustomizations
	| ITokenColorCustomizations
	| IExperimentalSemanticTokenColorCustomizations
	| ISemanticTokenColorCustomizations;

export interface ISemanticTokenRules {
	[selector: string]: string | ISemanticTokenColorizationSetting | undefined;
}

export interface ITextMateThemingRule {
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}

export interface ITokenColorizationSetting {
	foreground?: string;
	background?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	fontFamily?: string;
	fontSize?: number;
	lineHeight?: number;
}

export interface ISemanticTokenColorizationSetting {
	foreground?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	italic?: boolean;
}

export interface ExtensionData {
	extensionId: string;
	extensionPublisher: string;
	extensionName: string;
	extensionIsBuiltin: boolean;
}

export namespace ExtensionData {
	export function toJSONObject(d: ExtensionData | undefined): any {
		return d && { _extensionId: d.extensionId, _extensionIsBuiltin: d.extensionIsBuiltin, _extensionName: d.extensionName, _extensionPublisher: d.extensionPublisher };
	}
	export function fromJSONObject(o: any): ExtensionData | undefined {
		if (o && isString(o._extensionId) && isBoolean(o._extensionIsBuiltin) && isString(o._extensionName) && isString(o._extensionPublisher)) {
			return { extensionId: o._extensionId, extensionIsBuiltin: o._extensionIsBuiltin, extensionName: o._extensionName, extensionPublisher: o._extensionPublisher };
		}
		return undefined;
	}
	export function fromName(publisher: string, name: string, isBuiltin = false): ExtensionData {
		return { extensionPublisher: publisher, extensionId: `${publisher}.${name}`, extensionName: name, extensionIsBuiltin: isBuiltin };
	}
}

export interface IThemeExtensionPoint {
	id: string;
	label?: string;
	description?: string;
	path: string;
	uiTheme?: ThemeTypeSelector;
	_watch: boolean; // unsupported options to watch location
}
