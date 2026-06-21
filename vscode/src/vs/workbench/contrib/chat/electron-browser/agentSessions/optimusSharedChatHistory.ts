/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Delayer } from '../../../../../base/common/async.js';
import { ipcRenderer } from '../../../../../base/parts/sandbox/electron-browser/globals.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IAgentSession, AgentSessionStatus, getAgentChangesSummary } from '../../browser/agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../browser/agentSessions/agentSessionsService.js';
import { IChatService, IChatDetail, ResponseModelState, convertLegacyChatSessionTiming } from '../../common/chatService/chatService.js';

interface IOptimusSharedChatHistorySnapshot {
	readonly version: 1;
	readonly updatedAt: number;
	readonly entries: readonly IOptimusSharedChatHistoryEntry[];
}

interface IOptimusSharedChatHistoryEntry {
	readonly id: string;
	readonly source: 'editor' | 'agents';
	readonly title?: string;
	readonly prompt?: string;
	readonly status?: string;
	readonly startedAt?: number;
	readonly updatedAt?: number;
	readonly currentWorkspace?: string;
	readonly messages: readonly { readonly role: string; readonly content: string }[];
	readonly fileChanges: readonly { readonly path: string; readonly added?: number; readonly removed?: number }[];
}

export class OptimusSharedChatHistoryContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.optimusSharedChatHistory';

	private readonly refreshDelayer = this._register(new Delayer<void>(250));

	constructor(
		@IChatService private readonly chatService: IChatService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this.registerListeners();
		this.scheduleRefresh();
	}

	private registerListeners(): void {
		this._register(this.chatService.onDidPerformUserAction(() => this.scheduleRefresh()));
		this._register(this.chatService.onDidDisposeSession(() => this.scheduleRefresh()));
		this._register(this.agentSessionsService.model.onDidChangeSessions(() => this.scheduleRefresh()));
		this._register(this.agentSessionsService.onDidChangeSessionArchivedState(() => this.scheduleRefresh()));
	}

	private scheduleRefresh(): void {
		this.refreshDelayer.trigger(() => this.writeSnapshot())
			.catch(error => this.logService.warn('Optimus shared chat history snapshot failed', error));
	}

	private async writeSnapshot(): Promise<void> {
		const entries = new Map<string, IOptimusSharedChatHistoryEntry>();

		for (const chat of await this.chatService.getLiveSessionItems()) {
			const entry = this.localChatToEntry(chat);
			if (entry) {
				entries.set(entry.id, entry);
			}
		}

		for (const chat of await this.chatService.getHistorySessionItems()) {
			const entry = this.localChatToEntry(chat);
			if (entry && !entries.has(entry.id)) {
				entries.set(entry.id, entry);
			}
		}

		for (const session of this.agentSessionsService.model.sessions) {
			const entry = this.agentSessionToEntry(session);
			if (entry) {
				entries.set(entry.id, entry);
			}
		}

		const snapshot: IOptimusSharedChatHistorySnapshot = {
			version: 1,
			updatedAt: Date.now(),
			entries: [...entries.values()].sort((left, right) => (right.updatedAt ?? right.startedAt ?? 0) - (left.updatedAt ?? left.startedAt ?? 0))
		};

		const result = await ipcRenderer.invoke('vscode:optimusSharedChatHistorySnapshot', snapshot) as { readonly accepted?: boolean; readonly error?: string } | undefined;
		if (!result?.accepted) {
			this.logService.warn('Optimus shared chat history snapshot was rejected', result?.error);
		}
	}

	private localChatToEntry(chat: IChatDetail): IOptimusSharedChatHistoryEntry | undefined {
		const id = chat.sessionResource.toString();
		if (!id) {
			return undefined;
		}

		const timing = convertLegacyChatSessionTiming(chat.timing);
		const liveModel = this.chatService.getSession(chat.sessionResource);
		const prompt = liveModel?.getRequests().find(request => !request.isSystemInitiated)?.message.text;

		return {
			id,
			source: 'editor',
			title: chat.title,
			prompt,
			status: localChatStatus(chat.lastResponseState),
			startedAt: timing.created,
			updatedAt: chat.lastMessageDate || timing.lastRequestEnded || timing.lastRequestStarted || timing.created,
			currentWorkspace: chat.workingDirectory?.fsPath,
			messages: prompt ? [{ role: 'user', content: prompt }] : [],
			fileChanges: chat.stats ? [{ path: `${chat.stats.fileCount} changed file${chat.stats.fileCount === 1 ? '' : 's'}`, added: chat.stats.added, removed: chat.stats.removed }] : []
		};
	}

	private agentSessionToEntry(session: IAgentSession): IOptimusSharedChatHistoryEntry | undefined {
		if (session.isArchived()) {
			return undefined;
		}

		const timing = session.timing;
		const changes = getAgentChangesSummary(session.changes);
		const prompt = typeof session.description === 'string' ? session.description : undefined;

		return {
			id: session.resource.toString(),
			source: 'agents',
			title: session.label,
			prompt,
			status: agentSessionStatus(session.status),
			startedAt: timing.created,
			updatedAt: timing.lastRequestEnded ?? timing.lastRequestStarted ?? timing.created,
			currentWorkspace: session.metadata?.workingDirectoryPath ?? session.metadata?.repositoryPath,
			messages: prompt ? [{ role: 'user', content: prompt }] : [],
			fileChanges: changes ? [{ path: `${changes.files} changed file${changes.files === 1 ? '' : 's'}`, added: changes.insertions, removed: changes.deletions }] : []
		};
	}
}

function localChatStatus(state: ResponseModelState): string {
	switch (state) {
		case ResponseModelState.Failed:
			return 'failed';
		case ResponseModelState.Cancelled:
			return 'cancelled';
		case ResponseModelState.NeedsInput:
			return 'needs-input';
		case ResponseModelState.Pending:
			return 'running';
		case ResponseModelState.Complete:
		default:
			return 'completed';
	}
}

function agentSessionStatus(status: AgentSessionStatus): string {
	switch (status) {
		case AgentSessionStatus.Failed:
			return 'failed';
		case AgentSessionStatus.InProgress:
			return 'running';
		case AgentSessionStatus.NeedsInput:
			return 'needs-input';
		case AgentSessionStatus.Completed:
		default:
			return 'completed';
	}
}
