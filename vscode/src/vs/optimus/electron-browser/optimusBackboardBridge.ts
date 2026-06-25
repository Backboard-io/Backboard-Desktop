/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcRenderer } from '../../base/parts/sandbox/electron-browser/globals.js';
import { IOptimusChatBridge } from '../common/optimusChatBridge.js';
import { IOptimusActivityEvent, IOptimusRun, IOptimusRunRequest, IOptimusTranscript, OptimusActivityState, OptimusProvider, OptimusRunStatus } from '../common/optimusTypes.js';

interface IBackboardCommandResult {
	readonly accepted?: boolean;
	readonly id?: string;
	readonly error?: string;
}

export class ElectronOptimusBackboardBridge implements IOptimusChatBridge {

	private readonly runs = new Map<string, IOptimusRun>();
	private readonly transcripts = new Map<string, IOptimusTranscript>();
	private counter = 0;

	async createRun(request: IOptimusRunRequest): Promise<IOptimusRun> {
		const id = `optimus-${Date.now()}-${++this.counter}`;
		await this.sendPanelCommand({
			id,
			type: 'sendPrompt',
			prompt: request.task,
			provider: request.provider,
			workspace: request.workspace,
			newChat: true
		});
		const run: IOptimusRun = {
			id,
			title: titleFromTask(request.task),
			provider: request.provider,
			status: OptimusRunStatus.Running,
			task: request.task,
			command: request.task,
			activity: [
				activity('Sent to Backboard editor panel', OptimusActivityState.Done),
				activity('Opened shared Backboard right panel', OptimusActivityState.Active),
				activity('Waiting for Backboard history sync', OptimusActivityState.Waiting)
			],
			touchedFiles: [],
			model: request.provider === OptimusProvider.Copilot ? 'Copilot / Backboard panel' : 'Backboard panel',
			workspace: request.workspace,
			capabilities: capabilitiesForStatus(OptimusRunStatus.Running)
		};
		this.runs.set(id, run);
		this.transcripts.set(id, {
			runId: id,
			messages: [
				message('user', request.task),
				message('system', 'This run is controlled by the real Backboard right panel in the editor window.')
			]
		});
		return run;
	}

	async sendMessage(runId: string, messageText: string, workspace?: string): Promise<IOptimusRun> {
		const run = this.requireRun(runId);
		await this.sendPanelCommand({
			id: `${runId}-${Date.now()}`,
			type: 'sendPrompt',
			prompt: messageText,
			chatId: run.chatRef,
			provider: run.provider,
			workspace: workspace ?? run.workspace
		});
		const next = {
			...run,
			status: OptimusRunStatus.Running,
			activity: [
				activity('Follow-up sent to Backboard editor panel', OptimusActivityState.Done),
				activity(messageText, OptimusActivityState.Active),
				...run.activity.slice(0, 4)
			],
			workspace: workspace ?? run.workspace,
			capabilities: capabilitiesForStatus(OptimusRunStatus.Running)
		};
		this.runs.set(runId, next);
		this.appendMessage(runId, message('user', messageText));
		return next;
	}

	async stopRun(runId: string): Promise<IOptimusRun> {
		const run = this.requireRun(runId);
		await this.sendPanelCommand({
			id: `${runId}-cancel-${Date.now()}`,
			type: 'cancel'
		});
		const next = {
			...run,
			status: OptimusRunStatus.Canceled,
			activity: [activity('Cancel sent to Backboard editor panel', OptimusActivityState.Failed), ...run.activity.slice(0, 5)],
			capabilities: capabilitiesForStatus(OptimusRunStatus.Canceled)
		};
		this.runs.set(runId, next);
		return next;
	}

	async retryRun(runId: string): Promise<IOptimusRun> {
		const run = this.requireRun(runId);
		return this.sendMessage(runId, run.task);
	}

	async reviewRun(runId: string): Promise<IOptimusRun> {
		const run = this.requireRun(runId);
		await this.sendPanelCommand({
			id: `${runId}-review-${Date.now()}`,
			type: 'reviewChanges'
		});
		return {
			...run,
			activity: [activity('Review opened in editor', OptimusActivityState.Done), ...run.activity.slice(0, 5)]
		};
	}

	async openWorktree(runId: string): Promise<IOptimusRun> {
		const run = this.requireRun(runId);
		await this.sendPanelCommand({
			id: `${runId}-open-${Date.now()}`,
			type: 'showChat'
		});
		return {
			...run,
			activity: [activity('Backboard editor panel focused', OptimusActivityState.Done), ...run.activity.slice(0, 5)]
		};
	}

	async openTranscript(runId: string): Promise<IOptimusTranscript> {
		return this.transcripts.get(runId) ?? { runId, messages: [] };
	}

	private appendMessage(runId: string, nextMessage: IOptimusTranscript['messages'][number]): void {
		const transcript = this.transcripts.get(runId) ?? { runId, messages: [] };
		this.transcripts.set(runId, {
			runId,
			messages: [...transcript.messages, nextMessage]
		});
	}

	private requireRun(runId: string): IOptimusRun {
		const run = this.runs.get(runId);
		if (!run) {
			throw new Error(`Unknown Optimus run: ${runId}`);
		}
		return run;
	}

	private async sendPanelCommand(command: Record<string, unknown>): Promise<void> {
		const result = await ipcRenderer.invoke('vscode:optimusBackboardCommand', command) as IBackboardCommandResult | undefined;
		if (!result?.accepted) {
			throw new Error(result?.error ?? 'Backboard editor panel did not accept the Optimus command.');
		}
	}
}

function titleFromTask(task: string): string {
	const title = task.trim().replace(/\s+/g, ' ').slice(0, 72);
	return title || 'New Advanced run';
}

function activity(text: string, state: OptimusActivityState): IOptimusActivityEvent {
	return {
		id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
		text,
		state,
		timestamp: Date.now()
	};
}

function message(author: 'user' | 'agent' | 'system', text: string): IOptimusTranscript['messages'][number] {
	return {
		id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
		author,
		text,
		timestamp: Date.now()
	};
}

function capabilitiesForStatus(status: OptimusRunStatus) {
	return {
		canStop: status === OptimusRunStatus.Running || status === OptimusRunStatus.Queued,
		canRetry: status === OptimusRunStatus.Error || status === OptimusRunStatus.Canceled,
		canReview: true,
		canApply: false,
		canOpenWorktree: true,
		canDismiss: status === OptimusRunStatus.Done || status === OptimusRunStatus.Error || status === OptimusRunStatus.Canceled,
		canQuickChat: status !== OptimusRunStatus.Canceled
	};
}
