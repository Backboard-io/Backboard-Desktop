/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMarkdownString } from '../../../../../../../base/common/htmlContent.js';
import { basename } from '../../../../../../../base/common/resources.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { localize } from '../../../../../../../nls.js';
import { migrateLegacyTerminalToolSpecificData } from '../../../../common/chat.js';
import { IChatExternalEdit, IChatMarkdownContent, IChatToolInvocation, IChatToolInvocationSerialized } from '../../../../common/chatService/chatService.js';
import { IChatTextEditGroup } from '../../../../common/model/chatModel.js';
import { createCoreToolCardViewModel } from '../toolInvocationParts/chatCoreToolProgressPart.js';
import { isMcpToolInvocation } from '../toolInvocationParts/chatToolPartUtilities.js';
import { CodexIconName } from './codexIcons.js';

/**
 * Codex's presentation model for one transcript activity, derived from
 * Backboard's tool data. Labels and grouping follow the Codex desktop app
 * (SPEC §2–§3): finished rows read as `Ran …`, `Read …`, `Searched for …`,
 * `Edited …`; running work only surfaces through the group's live header.
 */

export type CodexActivityMetadata = IChatToolInvocation | IChatToolInvocationSerialized | IChatMarkdownContent | IChatExternalEdit | IChatTextEditGroup;

export const enum CodexActivityKind {
	Command = 'command',
	Read = 'read',
	Search = 'search',
	List = 'list',
	Web = 'web',
	Edit = 'edit',
	Mcp = 'mcp',
	Tool = 'tool',
	Browser = 'browser',
	Image = 'image',
	Plan = 'plan',
}

export interface ICodexActivity {
	readonly kind: CodexActivityKind;
	readonly icon: CodexIconName;
	readonly running: boolean;
	readonly failed: boolean;
	/** Finished row label. */
	readonly verb?: string;
	readonly text?: string;
	readonly file?: { readonly label: string; readonly uri?: URI };
	readonly added?: number;
	readonly removed?: number;
	/** Present-tense label for the group's live header while this item runs. */
	readonly live: string;
	/** Whether the row has a disclosure body (Codex: commands, edits, tool calls). */
	readonly expandable: boolean;
	/** MCP server or integration name, for `Used {sources} integration` summaries. */
	readonly source?: string;
	/** Terminal command + output for the expanded shell card. */
	readonly shell?: { readonly command: string; readonly output?: string; readonly exitCode?: number };
	/**
	 * Image generation: while running, the generating-image placeholder card is
	 * shown instead of a row; once done the row is dropped because the finished
	 * image renders as a gallery in the response markdown.
	 */
	readonly imageGeneration?: boolean;
	/** Header label while an edit row's diff is open (Codex hides the link and counts then). */
	readonly expandedText?: string;
}

function plain(message: string | IMarkdownString | undefined): string {
	if (!message) {
		return '';
	}
	const value = typeof message === 'string' ? message : message.value;
	return value.replace(/\\([`*_{}\[\]()#+\-.!])/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
}

/** Unwraps `bash|zsh|sh -lc '…'` the way Codex shows commands. */
export function codexDisplayCommand(command: string): string {
	const trimmed = command.trim();
	const match = /^(?:\/\S*\/)?(?:bash|zsh|sh)\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(trimmed);
	return (match ? match[2] : trimmed).trim();
}

function isToolInvocation(metadata: CodexActivityMetadata): metadata is IChatToolInvocation | IChatToolInvocationSerialized {
	return metadata.kind === 'toolInvocation' || metadata.kind === 'toolInvocationSerialized';
}

function humanizeToolName(toolId: string, serverLabel: string | undefined): string {
	const serverTokens = new Set((serverLabel ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
	const words = toolId.split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/)
		.map(w => w.toLowerCase())
		.filter(w => w && w !== 'mcp' && w !== 'server' && !serverTokens.has(w));
	const text = words.join(' ') || toolId;
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function describeCodexActivity(metadata: CodexActivityMetadata): ICodexActivity | undefined {
	if (metadata.kind === 'externalEdit') {
		const file = basename(metadata.uri);
		const verb = metadata.editKind === 'create'
			? localize('codex.created', "Created")
			: metadata.editKind === 'delete' ? localize('codex.deleted', "Deleted") : localize('codex.edited', "Edited");
		return {
			kind: CodexActivityKind.Edit, icon: 'pencil', running: false, failed: false,
			verb, file: { label: file, uri: metadata.uri },
			added: metadata.diff?.added, removed: metadata.diff?.removed,
			live: localize('codex.editingFiles', "Editing files"), expandable: true,
			expandedText: metadata.editKind === 'create'
				? localize('codex.createdFile', "Created file")
				: metadata.editKind === 'delete' ? localize('codex.deletedFile', "Deleted file") : localize('codex.editedFile', "Edited file"),
		};
	}
	if (metadata.kind === 'textEditGroup') {
		return {
			kind: CodexActivityKind.Edit, icon: 'pencil', running: !metadata.done, failed: false,
			verb: metadata.done ? localize('codex.edited', "Edited") : localize('codex.editing', "Editing"),
			file: { label: basename(metadata.uri), uri: metadata.uri },
			live: localize('codex.editingFiles', "Editing files"), expandable: true,
		};
	}
	if (metadata.kind === 'markdownContent') {
		return undefined;
	}
	if (!isToolInvocation(metadata)) {
		return undefined;
	}

	const running = !IChatToolInvocation.isComplete(metadata);
	const data = metadata.toolSpecificData;

	if (/generate[_-]?image/i.test(metadata.toolId)) {
		return {
			kind: CodexActivityKind.Image, icon: 'photo', running, failed: false,
			text: localize('codex.generatedImage', "Generated image"),
			live: localize('codex.generatingImage', "Generating image"),
			expandable: false, imageGeneration: true,
		};
	}

	if (data?.kind === 'terminal') {
		const terminal = migrateLegacyTerminalToolSpecificData(data);
		const command = codexDisplayCommand(terminal.commandLine.forDisplay ?? terminal.commandLine.userEdited ?? terminal.commandLine.toolEdited ?? terminal.commandLine.original);
		const exitCode = terminal.terminalCommandState?.exitCode;
		return {
			kind: CodexActivityKind.Command, icon: 'terminal', running,
			failed: exitCode !== undefined && exitCode !== 0,
			text: localize('codex.ranCommand', "Ran {0}", command),
			live: localize('codex.runningCommand', "Running {0}", command),
			expandable: true,
			shell: { command, output: terminal.terminalCommandOutput?.text, exitCode },
		};
	}

	if (data?.kind === 'coreTool') {
		const vm = createCoreToolCardViewModel(data);
		const summary = vm.summary ?? '';
		switch (data.toolKind) {
			case 'read': {
				const label = summary.split(/[\\/]/).pop() || summary;
				return {
					kind: CodexActivityKind.Read, icon: 'book', running, failed: vm.failed,
					verb: localize('codex.read', "Read"), file: { label, uri: summary ? URI.file(summary) : undefined },
					live: localize('codex.reading', "Reading {0}", label), expandable: false,
				};
			}
			case 'grep':
				return {
					kind: CodexActivityKind.Search, icon: 'search', running, failed: vm.failed,
					verb: localize('codex.searched', "Searched"), text: summary ? localize('codex.forQuery', "for {0}", summary) : localize('codex.forFiles', "for files"),
					live: summary ? localize('codex.searchingFor', "Searching for {0}", summary) : localize('codex.searchingFiles', "Searching files"),
					expandable: false,
				};
			case 'glob':
				return {
					kind: CodexActivityKind.List, icon: 'folder', running, failed: vm.failed,
					verb: localize('codex.listed', "Listed"), text: summary ? localize('codex.filesMatching', "files matching {0}", summary) : localize('codex.files', "files"),
					live: localize('codex.listingFiles', "Listing files"), expandable: false,
				};
			case 'webSearch':
			case 'fetchUrl':
				return {
					kind: CodexActivityKind.Web, icon: 'globe', running, failed: vm.failed,
					verb: localize('codex.searchedTheWeb', "Searched the web"), text: summary ? localize('codex.forQuery', "for {0}", summary) : undefined,
					live: summary ? localize('codex.searchingTheWebFor', "Searching the web for {0}", summary) : localize('codex.searchingTheWeb', "Searching the web"),
					expandable: false,
				};
			case 'browser':
			case 'computer':
				return {
					kind: CodexActivityKind.Browser, icon: 'globe', running, failed: vm.failed,
					text: plain(metadata.pastTenseMessage) || (data.toolKind === 'browser' ? localize('codex.usedTheBrowser', "Used the browser") : localize('codex.usedTheComputer', "Used the computer")),
					live: plain(metadata.invocationMessage) || localize('codex.usingTheBrowser', "Using the browser"),
					expandable: true, source: data.toolKind === 'browser' ? localize('codex.theBrowser', "the browser") : localize('codex.theComputer', "the computer"),
				};
			case 'todo':
				return {
					kind: CodexActivityKind.Plan, icon: 'folder', running, failed: vm.failed,
					text: localize('codex.updatedPlan', "Updated plan"), live: localize('codex.updatingPlan', "Updating plan"), expandable: true,
				};
			case 'generateVideo':
				return {
					kind: CodexActivityKind.Image, icon: 'photo', running, failed: vm.failed,
					text: running ? localize('codex.generatingVideo', "Generating video") : localize('codex.generatedVideo', "Generated video"),
					live: localize('codex.generatingVideo', "Generating video"), expandable: true,
				};
			default:
				return {
					kind: CodexActivityKind.Search, icon: 'search', running, failed: vm.failed,
					verb: localize('codex.searched', "Searched"), text: summary ? localize('codex.forQuery', "for {0}", summary) : undefined,
					live: localize('codex.searching', "Searching"), expandable: false,
				};
		}
	}

	if (data?.kind === 'mutation') {
		return {
			kind: CodexActivityKind.Edit, icon: 'pencil', running, failed: false,
			text: running ? localize('codex.editingFiles', "Editing files") : localize('codex.editedFiles', "Edited files"),
			live: localize('codex.editingFiles', "Editing files"), expandable: false,
		};
	}

	if (isMcpToolInvocation(metadata)) {
		const serverLabel = metadata.source?.type === 'mcp' ? (metadata.source.serverLabel ?? metadata.source.label) : undefined;
		const label = humanizeToolName(metadata.toolId, serverLabel);
		return {
			kind: CodexActivityKind.Mcp, icon: 'wrench', running, failed: false,
			text: label, live: label, expandable: true, source: serverLabel,
		};
	}

	// Codex labels dynamic tools by their presentation, else the humanized tool
	// name (SPEC §2.7) — never a raw `ToolName: {json}` invocation string.
	const readable = (value: string) => value && value !== metadata.toolId && !/[{[]/.test(value) ? value : humanizeToolName(metadata.toolId, undefined);
	const text = readable(plain(running ? metadata.invocationMessage : (metadata.pastTenseMessage ?? metadata.invocationMessage)));
	return {
		kind: CodexActivityKind.Tool, icon: 'wrench', running, failed: false,
		text, live: readable(plain(metadata.invocationMessage)), expandable: true,
	};
}

/**
 * Codex's completed group summary (SPEC §3.2): fixed part order, the first part
 * in sentence case and the rest lower case, joined with commas; counts only
 * choose singular or plural and are never shown.
 */
export function codexGroupSummary(activities: readonly ICodexActivity[]): { readonly text: string; readonly icon: CodexIconName } {
	const sources: string[] = [];
	let tools = 0, edits = 0, exploration = 0, commands = 0, web = 0;
	const firstOf = new Map<string, ICodexActivity>();
	const note = (part: string, activity: ICodexActivity) => { if (!firstOf.has(part)) { firstOf.set(part, activity); } };
	for (const a of activities) {
		switch (a.kind) {
			case CodexActivityKind.Mcp:
			case CodexActivityKind.Browser:
				if (a.source) {
					if (!sources.includes(a.source)) { sources.push(a.source); }
					note('sources', a);
				} else {
					tools++; note('tools', a);
				}
				break;
			case CodexActivityKind.Tool: case CodexActivityKind.Plan: case CodexActivityKind.Image:
				tools++; note('tools', a); break;
			case CodexActivityKind.Edit: edits++; note('edits', a); break;
			case CodexActivityKind.Read: case CodexActivityKind.Search: case CodexActivityKind.List: exploration++; note('exploration', a); break;
			case CodexActivityKind.Command: commands++; note('commands', a); break;
			case CodexActivityKind.Web: web++; note('web', a); break;
		}
	}

	const parts: { key: string; leading: string; following: string }[] = [];
	if (sources.length) {
		const list = sources.length === 1 ? sources[0] : localize('codex.listAnd', "{0} and {1}", sources.slice(0, -1).join(', '), sources[sources.length - 1]);
		const browserOnly = sources.every(s => s === localize('codex.theBrowser', "the browser") || s === localize('codex.theComputer', "the computer"));
		const leading = browserOnly ? localize('codex.usedSources', "Used {0}", list)
			: sources.length === 1 ? localize('codex.usedIntegration', "Used {0} integration", list) : localize('codex.usedIntegrations', "Used {0} integrations", list);
		parts.push({ key: 'sources', leading, following: leading.charAt(0).toLowerCase() + leading.slice(1) });
	}
	if (tools) {
		parts.push({ key: 'tools', leading: tools === 1 ? localize('codex.calledATool', "Called a tool") : localize('codex.calledTools', "Called tools"), following: tools === 1 ? localize('codex.calledAToolLower', "called a tool") : localize('codex.calledToolsLower', "called tools") });
	}
	if (edits) {
		parts.push({ key: 'edits', leading: edits === 1 ? localize('codex.editedAFile', "Edited a file") : localize('codex.editedFiles', "Edited files"), following: edits === 1 ? localize('codex.editedAFileLower', "edited a file") : localize('codex.editedFilesLower', "edited files") });
	}
	if (exploration) {
		parts.push({ key: 'exploration', leading: localize('codex.readFiles', "Read files"), following: localize('codex.readFilesLower', "read files") });
	}
	if (commands) {
		parts.push({ key: 'commands', leading: commands === 1 ? localize('codex.ranACommand', "Ran a command") : localize('codex.ranCommands', "Ran commands"), following: commands === 1 ? localize('codex.ranACommandLower', "ran a command") : localize('codex.ranCommandsLower', "ran commands") });
	}
	if (web) {
		parts.push({ key: 'web', leading: localize('codex.searchedTheWeb', "Searched the web"), following: localize('codex.searchedTheWebLower', "searched the web") });
	}
	if (!parts.length) {
		return { text: localize('codex.worked', "Worked"), icon: 'wrench' };
	}
	const text = [parts[0].leading, ...parts.slice(1).map(p => p.following)].join(', ');
	return { text, icon: firstOf.get(parts[0].key)?.icon ?? 'wrench' };
}
