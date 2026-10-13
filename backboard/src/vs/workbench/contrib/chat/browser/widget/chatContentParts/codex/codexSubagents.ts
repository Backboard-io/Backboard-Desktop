/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../../../base/browser/window.js';
import { localize } from '../../../../../../../nls.js';
import { codexAgentAvatar } from './codexAvatars.js';
import { applyCodexRoot, cxEl } from './codexDom.js';

/** One worker in Codex's inline subagent sentence. */
export interface ICodexSubagent {
	/** Stable per-agent id; seeds the avatar glyph (Codex hashes the thread id). */
	readonly id: string;
	readonly name: string | undefined;
	/** Lower-case worker lifecycle (`running`, `completed`, `failed`, `cancelled`, …). */
	readonly status: string | undefined;
	readonly active: boolean;
	readonly open?: () => void;
}

export const enum CodexSubagentStatus {
	Active = 'active',
	Interrupted = 'interrupted',
	Completed = 'completed',
	Failed = 'failed',
}

const MAX_AVATARS = 4;

/**
 * Group status (SPEC §7.2): any interrupted → interrupted; every agent done →
 * finished (with errors when one failed); otherwise still working.
 */
export function codexSubagentStatus(agents: readonly Pick<ICodexSubagent, 'status' | 'active'>[]): CodexSubagentStatus {
	let done = 0, failed = 0;
	for (const agent of agents) {
		switch (agent.status) {
			case 'cancelled':
				return CodexSubagentStatus.Interrupted;
			case 'failed':
			case 'conflict':
				failed++;
				done++;
				break;
			case 'completed':
			case 'complete':
			case 'integrated':
				done++;
				break;
			case undefined:
				if (!agent.active) {
					done++;
				}
				break;
		}
	}
	if (agents.length > 0 && done === agents.length) {
		return failed ? CodexSubagentStatus.Failed : CodexSubagentStatus.Completed;
	}
	return CodexSubagentStatus.Active;
}

/** Fills `{0}`-style placeholders in a localized template with text or nodes. */
function fillTemplate(template: string, values: readonly (string | Node)[]): (string | Node)[] {
	const out: (string | Node)[] = [];
	let last = 0;
	for (const match of template.matchAll(/\{(?<index>\d+)\}/g)) {
		out.push(template.slice(last, match.index));
		out.push(values[Number(match.groups!.index)] ?? '');
		last = match.index! + match[0].length;
	}
	out.push(template.slice(last));
	return out.filter(part => part !== '');
}

function renderName(agent: ICodexSubagent): HTMLElement {
	const name = agent.name?.trim() || localize('codex.subagent', "Subagent");
	if (!agent.open) {
		const span = cxEl('span');
		span.textContent = name;
		return span;
	}
	const open = agent.open;
	const button = cxEl('span', 'inline cursor-interaction rounded-sm text-start hover:text-default');
	button.setAttribute('role', 'button');
	button.tabIndex = 0;
	button.textContent = name;
	button.setAttribute('aria-label', localize('codex.openSubagent', "Open {0} subagent", name));
	button.addEventListener('click', e => { e.stopPropagation(); open(); });
	button.addEventListener('keydown', e => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			open();
		}
	});
	return button;
}

/** `Alpha`, `Alpha and Beta`, `Alpha, Beta and Gamma`, `Alpha, Beta and 2 more` — no Oxford comma. */
function renderNames(agents: readonly ICodexSubagent[]): (string | Node)[] {
	const names = agents.slice(0, agents.length > 3 ? 2 : 3).map(renderName);
	switch (agents.length) {
		case 1:
			return names;
		case 2:
			return fillTemplate(localize('codex.subagents.two', "{0} and {1}"), names);
		case 3:
			return fillTemplate(localize('codex.subagents.three', "{0}, {1} and {2}"), names);
		default: {
			const more = cxEl('span');
			more.textContent = localize('codex.subagents.more', "{0} more", agents.length - 2);
			return fillTemplate(localize('codex.subagents.three', "{0}, {1} and {2}"), [...names, more]);
		}
	}
}

function sentenceTemplate(status: CodexSubagentStatus, count: number): string {
	switch (status) {
		case CodexSubagentStatus.Completed:
			return localize('codex.subagents.finished', "{0} finished");
		case CodexSubagentStatus.Failed:
			return localize('codex.subagents.finishedWithErrors', "{0} finished with errors");
		case CodexSubagentStatus.Interrupted:
			return count === 1
				? localize('codex.subagents.wasInterrupted', "{0} was interrupted")
				: localize('codex.subagents.wereInterrupted', "{0} were interrupted");
		default:
			return localize('codex.subagents.startedWorking', "{0} started working");
	}
}

/**
 * Renders (or updates in place) Codex's inline subagent sentence (SPEC §7.2):
 * `[●●●●] Alpha, Beta and 2 more started working`. Avatar chips are keyed by
 * agent id so only newly arrived agents play the chip entrance.
 */
export function renderCodexSubagentSentence(host: HTMLElement, agents: readonly ICodexSubagent[]): void {
	let root = host.querySelector<HTMLElement>(':scope > .cx-subagent-sentence');
	if (!root) {
		root = applyCodexRoot(cxEl('div', 'min-w-0 text-size-chat relative overflow-visible py-0 cx-subagent-sentence'));
		const section = cxEl('section', 'flex min-w-0 items-start gap-1.5 text-base leading-5 select-none text-secondary');
		section.dataset.testid = 'subagent-activity-inline-group';
		section.append(cxEl('span', 'inline-flex h-5 shrink-0 items-center gap-1.5'), cxEl('span', 'min-w-0 break-words'));
		section.lastElementChild!.setAttribute('aria-live', 'polite');
		root.appendChild(section);
		host.prepend(root);
	}
	const section = root.firstElementChild as HTMLElement;
	const [avatars, sentence] = [section.firstElementChild as HTMLElement, section.lastElementChild as HTMLElement];

	const light = root.dataset.theme === 'light';
	const existing = new Map(Array.from(avatars.children, chip => [(chip as HTMLElement).dataset.agentId, chip as HTMLElement]));
	const wanted = agents.slice(0, MAX_AVATARS);
	const chips = wanted.map(agent => {
		const known = existing.get(agent.id);
		if (known) {
			known.removeAttribute('data-animate-entrance');
			return known;
		}
		const chip = codexAgentAvatar(agent.id, light, 'size-4 shrink-0 _chip_jj3nd_1');
		chip.dataset.agentId = agent.id;
		chip.setAttribute('data-animate-entrance', '');
		return chip;
	});
	avatars.replaceChildren(...chips);

	const status = codexSubagentStatus(agents);
	sentence.replaceChildren(...fillTemplate(sentenceTemplate(status, agents.length), [wrap(renderNames(agents))]));
	section.setAttribute('aria-label', sentence.textContent ?? '');
}

function wrap(parts: readonly (string | Node)[]): Node {
	const fragment = mainWindow.document.createDocumentFragment();
	fragment.append(...parts);
	return fragment;
}
