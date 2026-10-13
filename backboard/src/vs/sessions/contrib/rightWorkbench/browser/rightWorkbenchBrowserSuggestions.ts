/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';

/** Interpret addresses, local development ports, and plain-text searches. */
export function normalizeRightWorkbenchUrl(value: string): string | undefined {
	const text = value.trim();
	if (!text) {
		return undefined;
	}
	const explicit = /\b(?:https?|file):\/\/[^\s"'<>]+/i.exec(text);
	if (explicit) {
		return explicit[0];
	}
	if (text === 'about:blank') {
		return text;
	}
	const local = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:[/?#][^\s]*)?$/i;
	if (local.test(text)) {
		return `http://${text}`;
	}
	const port = /^:?(?<port>\d{2,5})(?<path>\/[^\s]*)?$/.exec(text);
	if (port?.groups && Number(port.groups.port) <= 65535) {
		return `http://localhost:${port.groups.port}${port.groups.path ?? ''}`;
	}
	if (/^(?:[\w-]+\.)+[\w-]+(?::\d{1,5})?(?:[/?#][^\s]*)?$/.test(text)) {
		return `https://${text}`;
	}
	return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

interface IBrowserSuggestion {
	readonly url: string;
	readonly title: string;
	readonly remove?: () => Promise<void>;
}

/** An address-bar list backed by the browser's own history, with keyboard navigation. */
export class RightWorkbenchBrowserSuggestions extends Disposable {
	private readonly rows = this._register(new DisposableStore());
	private readonly list: HTMLElement;
	private suggestions: IBrowserSuggestion[] = [];
	private selected = -1;
	private hiddenModels: IBrowserViewModel[] = [];

	constructor(
		private readonly anchor: HTMLElement,
		private readonly input: HTMLInputElement,
		private readonly getViews: () => readonly BrowserEditorInput[],
		private readonly navigate: (value: string) => void,
	) {
		super();
		this.list = append(anchor, $('.sessions-right-workbench-browser-suggestions'));
		this.list.id = `browser-suggestions-${generateUuid()}`;
		this.list.role = 'listbox';
		this.list.hidden = true;
		input.role = 'combobox';
		input.setAttribute('aria-autocomplete', 'list');
		input.setAttribute('aria-controls', this.list.id);
		input.setAttribute('aria-expanded', 'false');
		input.autocomplete = 'off';
		this._register(addDisposableListener(input, EventType.FOCUS, () => this.render()));
		this._register(addDisposableListener(input, EventType.INPUT, () => this.render()));
		this._register(addDisposableListener(anchor, EventType.FOCUS_OUT, event => {
			if (!anchor.contains(event.relatedTarget as Node | null)) {
				this.close();
			}
		}));
		this._register(addDisposableListener(input.ownerDocument, EventType.MOUSE_DOWN, event => {
			if (!anchor.contains(event.target as Node)) {
				this.close();
			}
		}, true));
		this._register(addDisposableListener(input, EventType.KEY_DOWN, event => {
			if (event.isComposing) {
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.close();
			} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				if (this.list.hidden) {
					this.render();
				}
				if (this.suggestions.length) {
					this.selected = this.selected < 0
						? event.key === 'ArrowDown' ? 0 : this.suggestions.length - 1
						: (this.selected + (event.key === 'ArrowDown' ? 1 : this.suggestions.length - 1)) % this.suggestions.length;
					this.updateSelection();
				}
			} else if (event.key === 'Enter') {
				event.preventDefault();
				const value = !this.list.hidden && this.selected >= 0 ? this.suggestions[this.selected].url : input.value;
				this.close();
				this.navigate(value);
			}
		}));
	}

	private render(): void {
		this.rows.clear();
		clearNode(this.list);
		const needle = this.input.value.trim().toLowerCase();
		const entries: IBrowserSuggestion[] = [];
		const seen = new Set<string>();
		for (const view of this.getViews()) {
			const model = view.model;
			for (const entry of [...model?.history.entries.items ?? []].reverse()) {
				if (seen.has(entry.url) || (needle && !`${entry.title} ${entry.url}`.toLowerCase().includes(needle))) {
					continue;
				}
				seen.add(entry.url);
				entries.push({ url: entry.url, title: entry.title || entry.url, remove: () => model!.deleteHistory([entry.id]) });
			}
		}
		this.suggestions = entries.slice(0, 7);
		this.selected = -1;
		this.input.removeAttribute('aria-activedescendant');
		if (!this.suggestions.length) {
			this.close();
			return;
		}
		for (const [index, suggestion] of this.suggestions.entries()) {
			const row = append(this.list, $('.sessions-right-workbench-browser-suggestion'));
			row.id = `${this.list.id}-${index}`;
			row.role = 'option';
			row.setAttribute('aria-selected', 'false');
			row.appendChild(renderIcon(Codicon.globe));
			append(row, $('span.title', {}, suggestion.title));
			append(row, $('span.url', {}, suggestion.url.replace(/^https?:\/\//, '')));
			const remove = append(row, $('button.remove')) as HTMLButtonElement;
			remove.type = 'button';
			remove.ariaLabel = localize('rightWorkbench.removeHistory', "Remove {0} from history", suggestion.title);
			remove.appendChild(renderIcon(Codicon.close));
			this.rows.add(addDisposableListener(remove, EventType.CLICK, async event => {
				event.stopPropagation();
				await suggestion.remove?.();
				this.input.focus();
				this.render();
			}));
			this.rows.add(addDisposableListener(row, EventType.MOUSE_DOWN, event => event.preventDefault()));
			this.rows.add(addDisposableListener(row, EventType.CLICK, () => {
				this.input.value = suggestion.url;
				this.close();
				this.navigate(suggestion.url);
			}));
		}
		this.list.hidden = false;
		this.input.setAttribute('aria-expanded', 'true');
		// Electron browser surfaces sit above DOM overlays. Release them while
		// the list is open and restore precisely those that were visible.
		for (const view of this.getViews()) {
			if (view.model?.visible) {
				this.hiddenModels.push(view.model);
				void view.model.setVisible(false);
			}
		}
	}

	private updateSelection(): void {
		for (const [index, row] of Array.from(this.list.children).entries()) {
			row.setAttribute('aria-selected', String(index === this.selected));
			if (index === this.selected) {
				this.input.setAttribute('aria-activedescendant', row.id);
				row.scrollIntoView({ block: 'nearest' });
			}
		}
	}

	private close(restore = true): void {
		this.list.hidden = true;
		this.input.setAttribute('aria-expanded', 'false');
		this.input.removeAttribute('aria-activedescendant');
		if (restore && this.anchor.isConnected) {
			for (const model of this.hiddenModels) {
				void model.setVisible(true);
			}
		}
		this.hiddenModels = [];
	}

	override dispose(): void {
		this.close(false);
		this.list.remove();
		super.dispose();
	}
}
