/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clearNode } from '../../../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../../base/common/observable.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { localize } from '../../../../../../../nls.js';
import { IChatToolInvocation } from '../../../../common/chatService/chatService.js';
import { CodexActivityKind, CodexActivityMetadata, codexGroupSummary, describeCodexActivity, ICodexActivity } from './codexActivity.js';
import { animateCodexBody, applyCodexRoot, CodexCadencedShimmer, codexGap, codexIcon, codexRowChevron, codexNestedScroll, collapseCodexBodyInstantly, cxEl, renderCodexDiffStats, renderCodexRowLabel, setCodexChevronOpen } from './codexDom.js';
import { CodexIconName } from './codexIcons.js';
import { renderGeneratedImagePlaceholder } from '../../chatGeneratedImageGallery.js';

/** A live header label is held at least this long before swapping (SPEC §3.3). */
const LIVE_LABEL_HOLD_MS = 1000;

interface ICodexRow {
	readonly id: string;
	readonly metadata: CodexActivityMetadata;
	readonly content: HTMLElement | undefined;
	activity: ICodexActivity;
	readonly element: HTMLElement;
	readonly store: DisposableStore;
	expanded: boolean;
}

/**
 * One Codex activity unit: consecutive tool calls between two pieces of
 * commentary. Renders as Codex's collapsible group ("Read files, ran a
 * command ›"), or — when it holds a single finished item — as that item's
 * plain row (SPEC §3.1 single-item collapse). While work is running the header
 * shows the live action ("Running npm test", "Thinking") in the cadenced
 * shimmer; rows only list finished work.
 */
export class CodexActivityGroup extends Disposable {
	readonly element: HTMLElement;

	private readonly rows: ICodexRow[] = [];
	private readonly rowsById = new Map<string, ICodexRow>();
	private nextRowId = 0;

	private readonly headerSlot: HTMLElement;
	private readonly bodyOuter: HTMLElement;
	private readonly bodyList: HTMLElement;
	private readonly singleSlot: HTMLElement;
	/** Standalone slot for generating-image placeholders (never grouped). */
	private readonly imageSlot: HTMLElement;
	private readonly imagePlaceholders = new Map<string, HTMLElement>();
	private readonly chevron: SVGSVGElement;
	private readonly headerIcon: HTMLElement;
	private readonly headerLabel: HTMLElement;
	private readonly headerButton: HTMLButtonElement;
	private readonly liveShimmer = this._register(new MutableDisposable<CodexCadencedShimmer>());
	private readonly bodyAnimation = this._register(new MutableDisposable<IDisposable>());

	private expanded = false;
	private complete = false;
	private thinkingLabel: string | undefined;
	private shownLiveKey: string | undefined;
	private liveShownAt = 0;
	private readonly liveSwapTimer = this._register(new MutableDisposable<IDisposable>());

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight: Event<void> = this._onDidChangeHeight.event;

	/** @param openFile opens a row's file link; without it links are inert. */
	constructor(private readonly openFile?: (uri: URI) => void) {
		super();
		this.element = applyCodexRoot(cxEl('div', 'min-w-0 text-size-chat relative overflow-visible py-0 cx-activity-unit'));

		// Group shell (`yw` → `C_`).
		const groupRoot = cxEl('div', 'flex min-w-0 flex-col');
		this.headerButton = cxEl('button', 'group/activity-header inline-flex min-w-0 max-w-full self-start items-center gap-1 p-0 text-start cursor-interaction rounded-md bg-transparent focus-visible:px-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:ring-inset');
		this.headerButton.type = 'button';
		this.headerButton.setAttribute('aria-expanded', 'false');
		const outer = cxEl('span', 'inline-flex min-w-0 gap-1.5 items-center shrink truncate text-size-chat');
		const summarySlot = cxEl('span', 'text-text/60 flex min-w-0 max-w-full items-center truncate shrink group-hover/activity-header:text-default');
		const minH = cxEl('span', 'flex min-h-4 max-w-full min-w-0 items-center truncate');
		const inner = cxEl('span', 'inline-flex min-w-0 gap-1.5 items-center max-w-full overflow-hidden');
		this.headerIcon = cxEl('span', 'contents text-text/60');
		const labelWrap = cxEl('span', 'min-w-0 flex-1 truncate');
		this.headerLabel = cxEl('span', 'block min-w-0 max-w-full flex-1 truncate text-text/60 [&_*:not(button)]:!text-text/60 group-hover/activity-header:!text-default group-hover/activity-header:[&_*:not(button)]:!text-default');
		labelWrap.appendChild(this.headerLabel);
		inner.append(this.headerIcon, labelWrap);
		minH.appendChild(inner);
		summarySlot.appendChild(minH);
		outer.appendChild(summarySlot);
		this.chevron = codexRowChevron();
		this.headerButton.append(outer, this.chevron);
		this.headerSlot = this.headerButton;

		this.bodyOuter = cxEl('div', '-ms-2 ps-2');
		collapseCodexBodyInstantly(this.bodyOuter, false);
		this.bodyList = cxEl('div', '-ms-2 flex flex-col overflow-x-hidden ps-2 vertical-scroll-fade-mask max-h-56 overflow-y-auto [--edge-fade-distance:1.5rem]');
		this.bodyList.style.setProperty('--conversation-patch-file-gap', 'var(--conversation-grouped-item-gap, 4px)');
		this.bodyOuter.appendChild(this.bodyList);
		this._register(codexNestedScroll(this.bodyList));
		groupRoot.append(this.headerSlot, this.bodyOuter);

		this.singleSlot = cxEl('div', 'contents');
		this.imageSlot = cxEl('div', 'flex flex-col gap-3');
		this.element.append(groupRoot, this.singleSlot, this.imageSlot);

		this._register(toDisposable(() => this.rows.forEach(r => r.store.dispose())));
		this.headerButton.addEventListener('click', () => this.setExpanded(!this.expanded));
		this.render();
	}

	get isEmpty(): boolean {
		return this.rows.length === 0 && !this.thinkingLabel;
	}

	/** Adds a work item. `content` is the native Backboard part, shown as the row's expanded body. */
	addRow(metadata: CodexActivityMetadata, content: HTMLElement | undefined): string | undefined {
		const activity = describeCodexActivity(metadata);
		if (!activity) {
			return undefined;
		}
		const id = `cx-row-${this.nextRowId++}`;
		const store = new DisposableStore();
		const row: ICodexRow = { id, metadata, content, activity, element: cxEl('div'), store, expanded: false };
		this.rows.push(row);
		this.rowsById.set(id, row);
		this.renderRow(row);

		if (metadata.kind === 'toolInvocation') {
			store.add(autorun(reader => {
				metadata.state.read(reader);
				const next = describeCodexActivity(metadata);
				if (next) {
					row.activity = next;
					this.renderRow(row);
					this.render();
				}
			}));
		}
		this.render();
		return id;
	}

	updateEditStats(rowId: string, added: number, removed: number): void {
		const row = this.rowsById.get(rowId);
		if (row && row.activity.kind === CodexActivityKind.Edit) {
			row.activity = { ...row.activity, added, removed };
			this.renderRow(row);
		}
	}

	removeRowsFor(predicate: (metadata: CodexActivityMetadata) => boolean): void {
		for (const row of [...this.rows]) {
			if (predicate(row.metadata)) {
				row.store.dispose();
				row.element.remove();
				this.rows.splice(this.rows.indexOf(row), 1);
				this.rowsById.delete(row.id);
			}
		}
		this.render();
	}

	/** Live fallback label while nothing is running: "Thinking" or the current reasoning heading. */
	setThinking(label: string | undefined): void {
		this.thinkingLabel = label;
		this.render();
	}

	setComplete(): void {
		if (this.complete) {
			return;
		}
		this.complete = true;
		this.thinkingLabel = undefined;
		this.render();
	}

	private fileOpener(uri: URI | undefined): (() => void) | undefined {
		const openFile = this.openFile;
		return openFile && uri ? () => openFile(uri) : undefined;
	}

	private setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) {
			return;
		}
		this.expanded = expanded;
		this.headerButton.setAttribute('aria-expanded', String(expanded));
		setCodexChevronOpen(this.chevron, expanded);
		this.bodyAnimation.value = animateCodexBody(this.bodyOuter, expanded);
		this._onDidChangeHeight.fire();
	}

	private runningRow(): ICodexRow | undefined {
		for (let i = this.rows.length - 1; i >= 0; i--) {
			if (this.rows[i].activity.running) {
				return this.rows[i];
			}
		}
		return undefined;
	}

	private render(): void {
		this.renderImagePlaceholders();
		const listed = this.rows.filter(r => !r.activity.generatedMedia);
		const finished = listed.filter(r => !r.activity.running);
		const running = this.complete ? undefined : this.runningRow();
		const live = !this.complete && (!!running || !!this.thinkingLabel);

		// Single finished item: its own row, no group header (SPEC §3.1).
		const single = !live && finished.length === 1 && listed.length === 1;
		this.headerSlot.parentElement!.hidden = single || (!live && finished.length === 0);
		if (single) {
			if (finished[0].element.parentElement !== this.singleSlot) {
				clearNode(this.singleSlot);
				this.singleSlot.appendChild(finished[0].element);
			}
		} else {
			clearNode(this.singleSlot);
			for (const row of this.rows) {
				if (row.activity.running || row.activity.generatedMedia) {
					row.element.remove();
					continue;
				}
				const holder = row.element.parentElement?.parentElement === this.bodyList ? row.element.parentElement : undefined;
				if (!holder) {
					const wrap = cxEl('div');
					wrap.append(codexGap(true), row.element);
					this.bodyList.appendChild(wrap);
				}
			}
		}

		// Header: live action (shimmer) or completed summary.
		if (live) {
			const key = running ? `active:${running.id}:${running.activity.live}` : `thinking:${this.thinkingLabel}`;
			const text = running ? running.activity.live : (this.thinkingLabel ?? localize('codex.thinking', "Thinking"));
			const icon: CodexIconName | undefined = running ? running.activity.icon : undefined;
			this.showLive(key, text, icon);
		} else {
			this.liveShimmer.clear();
			this.shownLiveKey = undefined;
			const summary = codexGroupSummary(finished.map(r => r.activity));
			this.setHeader(summary.icon, summary.text);
		}
		this.element.toggleAttribute('data-empty', !live && finished.length === 0);
		this.element.toggleAttribute('data-live', live);
		this.headerButton.disabled = finished.length === 0;
		this.chevron.style.display = finished.length === 0 ? 'none' : '';
		this._onDidChangeHeight.fire();
	}

	/** Running image generations show Codex's generating-image card; finished ones leave for the gallery. */
	private renderImagePlaceholders(): void {
		for (const row of this.rows) {
			const placeholder = this.imagePlaceholders.get(row.id);
			const wanted = !!row.activity.generatedMedia && row.activity.running;
			if (wanted && !placeholder) {
				const holder = cxEl('div');
				renderGeneratedImagePlaceholder(holder, row.activity.generatedMedia);
				this.imageSlot.appendChild(holder);
				this.imagePlaceholders.set(row.id, holder);
			} else if (!wanted && placeholder) {
				placeholder.remove();
				this.imagePlaceholders.delete(row.id);
			}
		}
	}

	private showLive(key: string, text: string, icon: CodexIconName | undefined): void {
		if (this.shownLiveKey === key) {
			return;
		}
		const now = Date.now();
		const wait = this.shownLiveKey ? LIVE_LABEL_HOLD_MS - (now - this.liveShownAt) : 0;
		if (wait > 0) {
			const handle = mainWindow.setTimeout(() => { this.liveSwapTimer.clear(); this.render(); }, wait);
			this.liveSwapTimer.value = toDisposable(() => mainWindow.clearTimeout(handle));
			return;
		}
		this.shownLiveKey = key;
		this.liveShownAt = now;
		clearNode(this.headerIcon);
		if (icon) {
			this.headerIcon.appendChild(codexIcon(icon));
		}
		const shimmer = new CodexCadencedShimmer(text, 'min-w-0 truncate');
		this.liveShimmer.value = shimmer;
		clearNode(this.headerLabel);
		this.headerLabel.appendChild(shimmer.element);
	}

	private setHeader(icon: CodexIconName, text: string): void {
		clearNode(this.headerIcon);
		this.headerIcon.appendChild(codexIcon(icon));
		clearNode(this.headerLabel);
		const span = cxEl('span', 'block max-w-full min-w-0 truncate');
		span.textContent = text;
		this.headerLabel.appendChild(span);
	}

	private renderRow(row: ICodexRow): void {
		const a = row.activity;
		const root = row.element;
		clearNode(root);
		root.className = 'min-w-0 text-size-chat relative overflow-visible py-0';
		const column = cxEl('div', a.expandable ? 'flex min-w-0 flex-col relative overflow-clip' : 'flex min-w-0 flex-col');
		root.appendChild(column);

		const hasStats = a.added !== undefined || a.removed !== undefined;
		const header = cxEl('div', a.expandable
			? `group/activity-header relative inline-flex max-w-full min-w-0 items-center gap-1 self-start${hasStats ? ' text-text/60' : ''}`
			: 'group/activity-header inline-flex min-w-0 max-w-full self-start items-center gap-1 p-0 text-start');
		column.appendChild(header);

		let toggle: HTMLButtonElement | undefined;
		if (a.expandable) {
			toggle = cxEl('button', 'absolute inset-0 cursor-interaction rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset');
			toggle.type = 'button';
			toggle.setAttribute('aria-expanded', String(row.expanded));
			header.appendChild(toggle);
		}
		const line = cxEl('span', a.expandable
			? 'inline-flex min-w-0 gap-1.5 items-center pointer-events-none relative shrink truncate text-size-chat [&_a]:pointer-events-auto [&_button]:pointer-events-auto'
			: 'inline-flex min-w-0 gap-1.5 items-center shrink truncate text-size-chat');
		const iconSlot = cxEl('span', 'contents text-text/60');
		iconSlot.appendChild(codexIcon(a.icon));
		const summary = cxEl('span', a.expandable
			? 'min-w-0 flex-1 truncate text-text/60 [&_*:not(button)]:!text-text/60 [@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:!text-default [@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:[&_*:not(button)]:!text-default'
			: 'min-w-0 flex-1 truncate text-text/60 [&_*:not(button)]:!text-text/60');
		if (a.kind === CodexActivityKind.Command) {
			const wrap = cxEl('span', 'min-w-0 truncate text-text/40 group-hover/activity-header:text-default');
			const text = cxEl('span', 'font-sans text-codex-description group-hover/activity-header:text-default');
			text.textContent = a.text ?? '';
			wrap.appendChild(text);
			summary.appendChild(wrap);
		} else {
			summary.appendChild(renderCodexRowLabel({ verb: a.verb, text: a.text, file: a.file ? { label: a.file.label, title: a.file.uri?.fsPath, onClick: this.fileOpener(a.file.uri) } : undefined }, a.kind === CodexActivityKind.Edit ? 'edit' : a.kind === CodexActivityKind.Read || a.kind === CodexActivityKind.Search || a.kind === CodexActivityKind.List ? 'read' : 'plain'));
		}
		// Codex swaps an open edit row's header to `Created file` and drops the link and counts.
		const collapsedLabel = summary.firstElementChild as HTMLElement | null;
		const expandedLabel = a.expandedText ? renderCodexRowLabel({ verb: a.expandedText }, 'edit') : undefined;
		if (expandedLabel) {
			summary.appendChild(expandedLabel);
		}
		line.append(iconSlot, summary);
		header.appendChild(line);
		toggle?.setAttribute('aria-label', a.kind === CodexActivityKind.Edit && a.file
			? localize('codex.toggleDiff', "Toggle diff for {0}", a.file.label)
			: summary.textContent ?? '');

		let stats: HTMLElement | undefined;
		if (hasStats) {
			stats = cxEl('div', 'flex items-center gap-1.5');
			stats.appendChild(renderCodexDiffStats(a.added ?? 0, a.removed ?? 0));
			header.appendChild(stats);
		}
		const applyExpandedHeader = () => {
			if (!expandedLabel) {
				return;
			}
			expandedLabel.style.display = row.expanded ? '' : 'none';
			for (const collapsedOnly of [collapsedLabel, stats]) {
				if (collapsedOnly) {
					collapsedOnly.style.display = row.expanded ? 'none' : '';
				}
			}
		};
		applyExpandedHeader();

		if (!a.expandable || !toggle) {
			return;
		}
		const chevronSlot = cxEl('span', 'pointer-events-none relative flex');
		const chevron = codexRowChevron();
		setCodexChevronOpen(chevron, row.expanded);
		chevronSlot.appendChild(chevron);
		header.appendChild(chevronSlot);

		const body = cxEl('div', 'overflow-hidden');
		collapseCodexBodyInstantly(body, row.expanded);
		column.appendChild(body);
		let mounted = false;
		const mount = () => {
			if (mounted) {
				return;
			}
			mounted = true;
			const inner = cxEl('div', 'flex flex-col gap-2 pt-2 pb-1');
			if (a.shell) {
				inner.appendChild(this.renderShellCard(row.metadata, a, row.store));
			} else if (row.content) {
				const native = cxEl('div', 'cx-native-body');
				native.appendChild(row.content);
				row.store.add(codexNestedScroll(native, '.chat-external-edit-diff-body'));
				inner.appendChild(native);
			}
			body.appendChild(inner);
		};
		if (row.expanded) {
			mount();
		}
		toggle.addEventListener('click', () => {
			row.expanded = !row.expanded;
			toggle!.setAttribute('aria-expanded', String(row.expanded));
			setCodexChevronOpen(chevron, row.expanded);
			applyExpandedHeader();
			mount();
			row.store.add(animateCodexBody(body, row.expanded));
			this._onDidChangeHeight.fire();
		});
	}

	/** Codex's exec body (`Fp`): bordered shell card with `$ command`, bottom-pinned output and exit status. */
	private renderShellCard(metadata: CodexActivityMetadata, a: ICodexActivity, store: DisposableStore): HTMLElement {
		// Re-read terminal data: output lands on the tool data after completion.
		const fresh = describeCodexActivity(metadata)?.shell ?? a.shell!;
		const card = cxEl('div', 'group flex flex-col overflow-hidden rounded-lg border border-strong bg-secondary-soft-alpha');
		const frame = cxEl('div', 'flex flex-col overflow-clip rounded-none border-none');
		const head = cxEl('div', 'flex items-center justify-between gap-2 px-2 py-1 font-sans text-sm text-codex-description select-none');
		const shellName = cxEl('span');
		shellName.textContent = /^(?:\S*\/)?(bash|zsh|sh)\b/.exec(fresh.command)?.[1] ?? localize('codex.shell', "Shell");
		head.appendChild(shellName);
		const content = cxEl('div', 'relative overflow-hidden');
		const rel = cxEl('div', 'relative');
		const cmdPad = cxEl('div', 'px-2 pt-2');
		const cmdGroup = cxEl('div', 'group/command relative pe-6');
		const cmd = cxEl('div', 'cursor-interaction rounded-md bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 text-size-chat-sm text-codex-description whitespace-pre-wrap break-words font-code line-clamp-2');
		cmd.setAttribute('role', 'button');
		cmd.tabIndex = 0;
		const prompt = cxEl('span', 'me-[1ch] text-tertiary');
		prompt.textContent = '$';
		const code = cxEl('code', 'contents');
		code.textContent = fresh.command;
		cmd.append(prompt, code);
		cmd.addEventListener('click', () => cmd.classList.toggle('line-clamp-2'));
		cmdGroup.appendChild(cmd);
		cmdPad.appendChild(cmdGroup);
		rel.appendChild(cmdPad);

		const outGroup = cxEl('div', 'group/output relative min-h-[1.25rem] pe-0');
		const outScroll = cxEl('div', 'vertical-scroll-fade-mask max-h-36 [--edge-fade-distance:2rem] box-border flex flex-col-reverse overflow-x-auto overflow-y-auto whitespace-pre font-code font-medium [animation-direction:reverse] text-codex-description text-size-chat-sm');
		const outPad = cxEl('div', 'w-max min-w-full p-2');
		const outCode = cxEl('code', 'text-codex-description');
		outCode.textContent = fresh.output?.replace(/\x1b\[[0-9;]*m/g, '').trimEnd() || localize('codex.noOutput', "No output");
		outPad.appendChild(outCode);
		outScroll.appendChild(outPad);
		store.add(codexNestedScroll(outScroll));
		outGroup.appendChild(outScroll);
		rel.appendChild(outGroup);
		content.appendChild(rel);
		frame.append(head, content);

		const footer = cxEl('div', 'flex items-center gap-2 px-2.5 pt-0.5 pb-1 text-size-chat text-tertiary');
		const status = cxEl('span', 'ms-auto flex items-center gap-1');
		if (fresh.exitCode === 0 || (fresh.exitCode === undefined && !a.failed && !a.running)) {
			status.append(codexIcon('check12', ''), localize('codex.success', "Success"));
		} else if (fresh.exitCode !== undefined) {
			status.textContent = localize('codex.exitCode', "Exit code {0}", fresh.exitCode);
		}
		footer.appendChild(status);
		card.append(frame, footer);
		return card;
	}
}

export function isCodexRunning(metadata: CodexActivityMetadata): boolean {
	return (metadata.kind === 'toolInvocation' || metadata.kind === 'toolInvocationSerialized') && !IChatToolInvocation.isComplete(metadata);
}
