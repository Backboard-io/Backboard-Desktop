/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { CodexActivityMetadata } from './codexActivity.js';
import { CodexActivityGroup } from './codexActivityGroup.js';
import { cxEl } from './codexDom.js';
import { CodexMarkdownRenderer, CodexReasoningItem } from './codexReasoning.js';

/**
 * The Codex units of one work segment, in order: tool runs become activity
 * groups and each reasoning section is its own standalone item between them
 * (Codex never groups reasoning with tool calls, SPEC §3.1).
 */
export class CodexActivitySequence extends Disposable {
	readonly element: HTMLElement;

	private readonly groups: CodexActivityGroup[] = [];
	private readonly reasoningItems: CodexReasoningItem[] = [];
	/** Reasoning section key → its item, so late updates never start a duplicate. */
	private readonly reasoningByKey = new Map<string, CodexReasoningItem>();
	/** Sequence row id → owning group and its group-local row id (group ids restart per group). */
	private readonly rowsById = new Map<string, { readonly group: CodexActivityGroup; readonly rowId: string }>();
	/** The tool run new rows join; closed when a reasoning section starts. */
	private openGroup: CodexActivityGroup | undefined;
	private openReasoning: { readonly key: string; readonly item: CodexReasoningItem } | undefined;
	private thinkingLabel: string | undefined;
	private complete = false;

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight: Event<void> = this._onDidChangeHeight.event;

	constructor(private readonly renderMarkdown: CodexMarkdownRenderer, private readonly openFile?: (uri: URI) => void) {
		super();
		this.element = cxEl('div', 'cx-activity-sequence');
		this.syncEmpty();
	}

	get isEmpty(): boolean {
		return this.groups.every(g => g.isEmpty) && this.reasoningItems.every(r => r.isEmpty);
	}

	/** Adds a tool row to the current run, starting a new group after reasoning. */
	addRow(metadata: CodexActivityMetadata, content: HTMLElement | undefined): string | undefined {
		this.finishReasoning();
		const group = this.ensureOpenGroup();
		const rowId = group.addRow(metadata, content);
		this.syncEmpty();
		if (!rowId) {
			return undefined;
		}
		const id = `${this.groups.indexOf(group)}/${rowId}`;
		this.rowsById.set(id, { group, rowId });
		return id;
	}

	updateEditStats(rowId: string, added: number, removed: number): void {
		const row = this.rowsById.get(rowId);
		row?.group.updateEditStats(row.rowId, added, removed);
	}

	removeRowsFor(predicate: (metadata: CodexActivityMetadata) => boolean): void {
		for (const group of this.groups) {
			group.removeRowsFor(predicate);
		}
		this.syncEmpty();
	}

	/**
	 * Live "Thinking" (or the reasoning heading) for the header of the current
	 * run. Hidden while a reasoning item is streaming — it already says so.
	 */
	setThinking(label: string | undefined): void {
		this.thinkingLabel = label;
		this.syncThinking();
	}

	/** Streams text into the reasoning section `key`, starting a new item for a new key. */
	setReasoning(key: string, text: string, live: boolean): void {
		if (this.reasoningByKey.has(key) && this.openReasoning?.key !== key) {
			// The renderer re-sends a section after a tool row closed it: refresh
			// it in place rather than opening a second `Thinking` below the tools.
			this.refreshReasoning(key, text);
			return;
		}
		if (this.openReasoning && this.openReasoning.key !== key) {
			this.finishReasoning();
		}
		if (!this.openReasoning) {
			if (!text.trim()) {
				return;
			}
			// Reasoning is standalone: it closes the tool run before it.
			this.closeOpenGroup();
			const item = this._register(new CodexReasoningItem(this.renderMarkdown, live && !this.complete));
			this._register(item.onDidChangeHeight(() => { this.syncEmpty(); this._onDidChangeHeight.fire(); }));
			this.reasoningItems.push(item);
			this.reasoningByKey.set(key, item);
			this.element.appendChild(item.element);
			this.openReasoning = { key, item };
		}
		this.openReasoning.item.update(text);
		this.syncThinking();
		this.syncEmpty();
	}

	/** Refreshes an already-rendered reasoning section in place; never opens one. */
	refreshReasoning(key: string, text: string): void {
		const item = this.reasoningByKey.get(key);
		if (item) {
			item.update(text);
			this.syncEmpty();
		}
	}

	/**
	 * Ends the streaming reasoning section: it settles to `Thought for Ns` and
	 * folds closed. Called when the section's successor arrives — a tool row,
	 * a new section, or the end of the unit (commentary, reply, turn end,
	 * cancel or error all mark the thinking part inactive).
	 */
	finishReasoning(): void {
		if (!this.openReasoning) {
			return;
		}
		this.openReasoning.item.finish();
		this.openReasoning = undefined;
		this.syncThinking();
	}

	setComplete(): void {
		if (this.complete) {
			return;
		}
		this.complete = true;
		this.finishReasoning();
		for (const group of this.groups) {
			group.setComplete();
		}
		this.syncEmpty();
	}

	private ensureOpenGroup(): CodexActivityGroup {
		if (!this.openGroup) {
			const group = this.openGroup = this._register(new CodexActivityGroup(this.openFile));
			this._register(group.onDidChangeHeight(() => { this.syncEmpty(); this._onDidChangeHeight.fire(); }));
			this.groups.push(group);
			this.element.appendChild(group.element);
			if (this.complete) {
				group.setComplete();
			}
		}
		return this.openGroup;
	}

	private closeOpenGroup(): void {
		if (this.openGroup) {
			this.openGroup.setComplete();
			this.openGroup = undefined;
		}
	}

	private syncThinking(): void {
		if (this.complete) {
			return;
		}
		const reasoningLive = !!this.openReasoning && !this.openReasoning.item.isEmpty;
		if (reasoningLive) {
			this.openGroup?.setThinking(undefined);
			return;
		}
		if (this.thinkingLabel) {
			this.ensureOpenGroup().setThinking(this.thinkingLabel);
		} else {
			this.openGroup?.setThinking(undefined);
		}
	}

	private syncEmpty(): void {
		this.element.toggleAttribute('data-empty', this.isEmpty);
	}
}
