/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import type { IAgentHostGenericConfigOption } from '../../agentSessions/agentHost/agentHostGenericConfigChips.js';

type ModelOption = Pick<IAgentHostGenericConfigOption, 'label' | 'getEnumInfo' | 'getCurrentValue' | 'getDynamicEnumInfo' | 'setValue'>;
type ModelCatalog = NonNullable<ReturnType<ModelOption['getEnumInfo']>>;

/** Image/video catalog contents within the composer's dismissible flow. */
export class BackboardModelPicker extends Disposable {
	private readonly rows = this._register(new DisposableStore());
	private readonly root: HTMLElement;
	private readonly subtitle: HTMLElement;
	private readonly refresh: HTMLButtonElement;
	private readonly search: HTMLInputElement;
	private readonly list: HTMLElement;
	private readonly status: HTMLElement;
	private items: { value: string; label: string; description?: string }[] = [];
	private current: string | undefined;
	private selected = 0;
	private request = 0;
	private locallySelected = false;
	private loading = false;
	private failed = false;

	constructor(body: HTMLElement, private readonly option: ModelOption, live: Promise<ModelCatalog>) {
		super();
		this.root = body.parentElement!;
		this.root.classList.add('backboard-composer-model-picker');
		const heading = this.root.querySelector<HTMLElement>('.backboard-composer-flow-header')!;
		const wrap = dom.$('.backboard-composer-model-heading');
		const title = heading.querySelector('strong');
		if (title) { wrap.appendChild(title); }
		this.subtitle = dom.append(wrap, dom.$('span.backboard-composer-model-subtitle'));
		heading.insertBefore(wrap, heading.firstChild);
		heading.querySelector('button')?.remove();
		const actions = dom.append(heading, dom.$('.backboard-composer-model-actions'));
		this.refresh = dom.append(actions, dom.$('button.backboard-composer-model-refresh', {
			type: 'button',
			'aria-label': localize('composer.models.refresh', "Refresh Models"),
			title: localize('composer.models.refresh', "Refresh Models"),
		}));
		// Keep the icon on its own element: flow buttons inherit the UI text font.
		this.refresh.appendChild(renderIcon(Codicon.refresh));
		this._register(dom.addDisposableListener(this.refresh, 'pointerdown', event => event.preventDefault()));
		this._register(dom.addDisposableListener(this.refresh, 'click', event => {
			event.stopPropagation();
			if (!this.loading) {
				void this.load(Promise.resolve().then(() => {
					const refreshed = this.option.getDynamicEnumInfo?.(true);
					if (!refreshed) { throw new Error('Model catalog is unavailable.'); }
					return refreshed;
				}));
			}
		}));

		this.search = dom.append(body, dom.$('input.backboard-composer-model-search', {
			type: 'text',
			placeholder: localize('composer.models.filter', "Filter models"),
			'aria-label': localize('composer.models.filterAria', "Filter models"),
		}));
		this.list = dom.append(body, dom.$('.backboard-composer-model-list', { role: 'listbox', 'aria-label': option.label }));
		this.status = dom.append(body, dom.$('p.backboard-composer-flow-status', { role: 'status' }));
		this._register(dom.addDisposableListener(this.search, 'input', () => { this.selected = 0; this.renderModels(); }));
		this._register(dom.addDisposableListener(this.search, 'keydown', event => {
			if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') { return; }
			event.preventDefault();
			event.stopPropagation();
			const rendered = Array.from(this.list.querySelectorAll<HTMLButtonElement>('button'));
			if (!rendered.length) { return; }
			if (event.key === 'Enter') { rendered[Math.min(this.selected, rendered.length - 1)]?.click(); return; }
			this.selected = (this.selected + (event.key === 'ArrowDown' ? 1 : -1) + rendered.length) % rendered.length;
			rendered.forEach((row, index) => {
				row.classList.toggle('keyboard-focused', index === this.selected);
				if (index === this.selected) { row.scrollIntoView({ block: 'nearest' }); }
			});
		}));
		const seed = option.getEnumInfo();
		const current = option.getCurrentValue?.() ?? seed?.current;
		this.current = typeof current === 'string' ? current : undefined;
		if (seed) { this.applyCatalog(seed); }
		void this.load(live);
		this.search.focus();
	}

	private async load(catalog: Promise<ModelCatalog>): Promise<void> {
		const request = ++this.request;
		const hadRefreshFocus = this.root.ownerDocument.activeElement === this.refresh;
		this.loading = true;
		this.failed = false;
		this.refresh.disabled = true;
		this.refresh.setAttribute('aria-busy', 'true');
		dom.reset(this.refresh, renderIcon(Codicon.loading));
		this.refresh.firstElementChild?.classList.add('codicon-modifier-spin');
		this.renderStatus();
		try {
			const next = await catalog;
			if (!this.isCurrent(request)) { return; }
			if (!this.locallySelected) {
				const current = this.option.getCurrentValue?.() ?? next.current;
				if (typeof current === 'string') { this.current = current; }
			}
			this.applyCatalog(next);
		} catch {
			if (this.isCurrent(request)) { this.failed = true; }
		} finally {
			if (this.isCurrent(request)) {
				this.loading = false;
				this.refresh.disabled = false;
				this.refresh.removeAttribute('aria-busy');
				dom.reset(this.refresh, renderIcon(Codicon.refresh));
				this.renderStatus();
				if (hadRefreshFocus && this.root.ownerDocument.activeElement === this.root.ownerDocument.body) {
					this.refresh.focus();
				}
			}
		}
	}

	private isCurrent(request: number): boolean {
		return !this._store.isDisposed && this.root.isConnected && request === this.request;
	}

	private applyCatalog(catalog: ModelCatalog): void {
		this.items = catalog.values.map((value, index) => ({ value, label: catalog.labels[index] ?? value, description: catalog.descriptions[index] }));
		this.renderModels();
	}

	private visibleItems(): typeof this.items {
		const query = this.search.value.trim().toLowerCase();
		return this.items.filter(item => !query || item.label.toLowerCase().includes(query) || item.value.toLowerCase().includes(query));
	}

	private renderStatus(): void {
		this.status.textContent = this.failed
			? localize('composer.models.retry', "Couldn't refresh models. Try Refresh again.")
			: this.loading
				? localize('composer.models.refreshing', "Refreshing models…")
				: this.visibleItems().length || !this.items.length
					? ''
					: localize('composer.models.noMatches', "No models match \"{0}\".", this.search.value.trim());
	}

	private renderModels(): void {
		const active = this.root.ownerDocument.activeElement;
		const focusedValue = active instanceof HTMLElement && this.list.contains(active) ? active.dataset.value : undefined;
		const scrollTop = this.list.scrollTop;
		this.rows.clear();
		dom.clearNode(this.list);
		const visible = this.visibleItems();
		if (this.selected >= visible.length) { this.selected = 0; }
		for (const item of visible) {
			const isSelected = item.value === this.current;
			const row = dom.append(this.list, dom.$('button.backboard-composer-model-choice', {
				type: 'button', role: 'option', 'aria-selected': String(isSelected), 'data-value': item.value,
			}));
			row.classList.toggle('selected', isSelected);
			row.title = item.description ? `${item.label} — ${item.description}` : item.label;
			const copy = dom.append(row, dom.$('.backboard-composer-model-choice-copy'));
			dom.append(copy, dom.$('.backboard-composer-model-choice-label', undefined, item.label));
			if (isSelected) { dom.append(row, dom.$('span.codicon.codicon-check.backboard-composer-model-check', { 'aria-hidden': 'true' })); }
			this.rows.add(dom.addDisposableListener(row, 'pointerdown', event => event.preventDefault()));
			this.rows.add(dom.addDisposableListener(row, 'click', event => {
				event.stopPropagation();
				this.current = item.value;
				this.locallySelected = true;
				this.option.setValue(item.value);
				this.renderModels();
				this.search.focus();
			}));
			if (focusedValue === item.value) { row.focus({ preventScroll: true }); }
		}
		if (focusedValue && !visible.some(item => item.value === focusedValue)) { this.search.focus(); }
		this.list.scrollTop = scrollTop;
		this.subtitle.textContent = this.items.find(item => item.value === this.current)?.label
			?? (!this.current || this.current === 'off' ? localize('composer.models.off', "Off") : this.current);
		this.renderStatus();
	}
}
