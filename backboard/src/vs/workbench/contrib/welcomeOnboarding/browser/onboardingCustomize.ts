/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';

/** The colours a theme card uses to draw its miniature editor. */
export interface IThemePreviewPalette {
	readonly editorBg: string;
	readonly chromeBg: string;
	readonly border: string;
	readonly fg: string;
	readonly keyword: string;
	readonly name: string;
	readonly text: string;
}

export const LIGHT_PREVIEW_PALETTE: IThemePreviewPalette = { editorBg: '#ffffff', chromeBg: '#f8f8f8', border: 'rgba(0, 0, 0, 0.1)', fg: '#3b3b3b', keyword: '#c4314b', name: '#8250df', text: '#0a6b3d' };
export const DARK_PREVIEW_PALETTE: IThemePreviewPalette = { editorBg: '#1f1f1f', chromeBg: '#181818', border: 'rgba(255, 255, 255, 0.08)', fg: '#cccccc', keyword: '#ff7b72', name: '#d2a8ff', text: '#a5d6ff' };
export const OTHER_PREVIEW_PALETTE: IThemePreviewPalette = { editorBg: '#1e2233', chromeBg: '#181c2b', border: 'rgba(255, 255, 255, 0.08)', fg: '#c8d0e8', keyword: '#82aaff', name: '#c792ea', text: '#c3e88d' };

export type ThemeChoice = 'light' | 'dark' | 'other';

export interface ICustomizePanel {
	readonly element: HTMLElement;
	readonly themeCards: ReadonlyMap<ThemeChoice, HTMLButtonElement>;
	/** Absent where the terminal command cannot be installed. */
	readonly terminalCheckbox: HTMLInputElement | undefined;
	readonly terminalHelp: HTMLElement | undefined;
	readonly importToggle: HTMLButtonElement;
	readonly importList: HTMLElement;
	readonly nextButton: HTMLButtonElement;
	setSelectedTheme(choice: ThemeChoice): void;
	setThemePalette(choice: ThemeChoice, palette: IThemePreviewPalette): void;
	addImportSource(id: string, label: string, iconUri: string): HTMLButtonElement;
	setSelectedImport(id: string | undefined): void;
}

/** A miniature editor: title bar, gutter, a code snippet and a side panel. */
function renderPreview(parent: HTMLElement, palette: IThemePreviewPalette): void {
	clearNode(parent);
	parent.style.background = palette.editorBg;
	parent.style.borderColor = palette.border;

	const titlebar = append(parent, $('.onboarding-theme-preview-titlebar'));
	titlebar.style.background = palette.chromeBg;
	titlebar.style.borderColor = palette.border;

	const gutter = append(parent, $('.onboarding-theme-preview-gutter'));
	gutter.style.background = palette.chromeBg;
	gutter.style.borderColor = palette.border;

	const code = append(parent, $('.onboarding-theme-preview-code'));
	code.style.color = palette.fg;
	const line = (...tokens: readonly (readonly [string, string?])[]): void => {
		const row = append(code, $('div'));
		for (const [text, color] of tokens) {
			const token = append(row, $('span'));
			token.textContent = text;
			if (color) {
				token.style.color = color;
			}
		}
	};
	line(['import', palette.keyword], [' React '], ['from', palette.keyword], [' \'react\';', palette.text]);
	line([' ']);
	line(['function', palette.keyword], [' App', palette.name], ['() {']);
	line(['  return', palette.keyword], [' (']);
	line(['    <div', palette.keyword], [' className', palette.name], ['="app"', palette.text], [' />', palette.keyword]);

	const side = append(parent, $('.onboarding-theme-preview-side'));
	side.style.borderColor = palette.border;
	for (const block of ['title', 'card', 'line', 'card-small']) {
		const element = append(side, $(`.onboarding-theme-preview-side-${block}`));
		element.style.borderColor = palette.border;
		if (block === 'title' || block === 'line') {
			element.style.background = palette.fg;
		}
	}
}

function createRadio(parent: HTMLElement): HTMLElement {
	const radio = append(parent, $('span.onboarding-radio'));
	radio.setAttribute('aria-hidden', 'true');
	append(radio, $('span.onboarding-radio-dot'));
	return radio;
}

/**
 * The "Customize" screen shown before sign-in: colour theme, terminal command
 * and an optional settings import. Only builds the markup; the caller decides
 * what each control does.
 */
export function createCustomizePanel(parent: HTMLElement, options: { readonly terminalCommand: string | undefined }): ICustomizePanel {
	const element = append(parent, $('.onboarding-customize'));

	append(element, $('h2.onboarding-customize-title')).textContent = localize('onboarding.customize.title', "Customize");
	append(element, $('p.onboarding-customize-label')).textContent = localize('onboarding.customize.theme', "Choose a color theme");

	const grid = append(element, $('.onboarding-theme-grid'));
	grid.setAttribute('role', 'radiogroup');
	grid.setAttribute('aria-label', localize('onboarding.customize.theme', "Choose a color theme"));

	const themeCards = new Map<ThemeChoice, HTMLButtonElement>();
	const previews = new Map<ThemeChoice, HTMLElement>();
	for (const [choice, label, palette] of [
		['light', localize('onboarding.customize.light', "Light"), LIGHT_PREVIEW_PALETTE],
		['dark', localize('onboarding.customize.dark', "Dark"), DARK_PREVIEW_PALETTE],
		['other', localize('onboarding.customize.other', "Other"), OTHER_PREVIEW_PALETTE],
	] as const) {
		const card = append(grid, $<HTMLButtonElement>('button.onboarding-theme-card'));
		card.type = 'button';
		card.setAttribute('role', 'radio');
		card.setAttribute('aria-checked', 'false');
		const head = append(card, $('.onboarding-theme-card-head'));
		append(head, $('span.onboarding-theme-card-label')).textContent = label;
		createRadio(head);
		const preview = append(card, $('.onboarding-theme-preview'));
		preview.setAttribute('aria-hidden', 'true');
		renderPreview(preview, palette);
		themeCards.set(choice, card);
		previews.set(choice, preview);
	}

	let terminalCheckbox: HTMLInputElement | undefined;
	let terminalHelp: HTMLElement | undefined;
	if (options.terminalCommand) {
		const row = append(element, $('.onboarding-customize-terminal'));
		const label = append(row, $('label.onboarding-checkbox'));
		terminalCheckbox = append(label, $<HTMLInputElement>('input'));
		terminalCheckbox.type = 'checkbox';
		terminalCheckbox.checked = true;
		const text = append(label, $('span'));
		append(text, $('span')).textContent = localize('onboarding.customize.install', "Install");
		append(text, $('code.onboarding-inline-code')).textContent = options.terminalCommand;
		append(text, $('span')).textContent = localize('onboarding.customize.terminalCommand', "terminal command");
		terminalHelp = append(row, $('span.onboarding-help-icon.codicon.codicon-question'));
		terminalHelp.tabIndex = 0;
		terminalHelp.setAttribute('aria-label', localize('onboarding.customize.terminalHelp', "Adds {0} as a terminal command that opens Backboard Studio. Open a new terminal to use it.", options.terminalCommand));
	}

	const importSection = append(element, $('.onboarding-customize-import'));
	const importToggle = append(importSection, $<HTMLButtonElement>('button.onboarding-customize-import-toggle'));
	importToggle.type = 'button';
	importToggle.setAttribute('aria-expanded', 'false');
	importToggle.hidden = true;
	append(importToggle, $('span')).textContent = localize('onboarding.customize.import', "Import settings");
	append(importToggle, $('span.codicon.codicon-chevron-right'));
	const importList = append(importSection, $('.onboarding-customize-import-list'));
	importList.hidden = true;
	const importHeading = append(importList, $('.onboarding-customize-import-heading'));
	append(importHeading, $('span')).textContent = localize('onboarding.customize.importHeading', "Import settings & extensions");
	append(importHeading, $('span.onboarding-customize-optional')).textContent = localize('onboarding.customize.optional', "Optional");
	const importRows = new Map<string, HTMLButtonElement>();

	const nextButton = append(element, $<HTMLButtonElement>('button.onboarding-signin-btn.onboarding-signin-btn-primary.onboarding-customize-next'));
	nextButton.type = 'button';
	append(nextButton, $('span.onboarding-signin-btn-label')).textContent = localize('onboarding.customize.next', "Next");
	const enterHint = append(nextButton, $('span.onboarding-signin-enter'));
	enterHint.textContent = '↵';
	enterHint.setAttribute('aria-hidden', 'true');

	return {
		element,
		themeCards,
		terminalCheckbox,
		terminalHelp,
		importToggle,
		importList,
		nextButton,
		setSelectedTheme: choice => {
			for (const [id, card] of themeCards) {
				card.classList.toggle('selected', id === choice);
				card.setAttribute('aria-checked', String(id === choice));
			}
		},
		setThemePalette: (choice, palette) => {
			const preview = previews.get(choice);
			if (preview) {
				renderPreview(preview, palette);
			}
		},
		addImportSource: (id, label, iconUri) => {
			const row = append(importList, $<HTMLButtonElement>('button.onboarding-import-row'));
			row.type = 'button';
			row.dataset.id = id;
			row.setAttribute('aria-pressed', 'false');
			const icon = append(row, $<HTMLImageElement>('img.onboarding-import-row-icon'));
			icon.alt = '';
			icon.src = iconUri;
			append(row, $('span.onboarding-import-row-label')).textContent = label;
			createRadio(row);
			importRows.set(id, row);
			importToggle.hidden = false;
			return row;
		},
		setSelectedImport: id => {
			for (const [rowId, row] of importRows) {
				row.classList.toggle('selected', rowId === id);
				row.setAttribute('aria-pressed', String(rowId === id));
			}
		},
	};
}
