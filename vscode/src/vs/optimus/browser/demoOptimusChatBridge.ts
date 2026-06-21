/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOptimusChatBridge } from '../common/optimusChatBridge.js';
import { IOptimusActivityEvent, IOptimusRun, IOptimusRunRequest, IOptimusTranscript, OptimusActivityState, OptimusProvider, OptimusRunStatus } from '../common/optimusTypes.js';

export class DemoOptimusChatBridge implements IOptimusChatBridge {

	private readonly runs = new Map<string, IOptimusRun>();
	private readonly transcripts = new Map<string, IOptimusTranscript>();
	private counter = 0;

	async createRun(request: IOptimusRunRequest): Promise<IOptimusRun> {
		const id = `optimus-${++this.counter}`;
		const run: IOptimusRun = {
			id,
			title: titleFromTask(request.task),
			provider: request.provider,
			status: OptimusRunStatus.Running,
			task: request.task,
			command: request.task,
			activity: [
				activity('Plan created', OptimusActivityState.Done),
				activity('Reading project context', OptimusActivityState.Active),
				activity('Waiting for chat bridge adapter', OptimusActivityState.Waiting)
			],
			touchedFiles: ['src/api/client.ts', 'src/ui/threadView.ts'],
			filesChanged: 2,
			model: request.provider === OptimusProvider.Copilot ? 'Copilot' : 'Backboard',
			cost: '$0.00',
			chatRef: `${request.provider}:${id}`,
			worktreeLabel: 'current project',
			branchLabel: `optimus/${id}`,
			applyStateLabel: 'pending',
			capabilities: capabilitiesForStatus(OptimusRunStatus.Running)
		};

		this.runs.set(id, run);
		this.transcripts.set(id, {
			runId: id,
			messages: [
				message('user', request.task),
				message('agent', 'Optimus created a standalone run. The real Copilot/Backboard adapter is the next layer to wire.')
			]
		});

		return run;
	}

	async sendMessage(runId: string, messageText: string): Promise<IOptimusRun> {
		const run = this.requireRun(runId);
		const updated = {
			...run,
			status: OptimusRunStatus.Running,
			capabilities: capabilitiesForStatus(OptimusRunStatus.Running),
			activity: [
				activity('Follow-up received', OptimusActivityState.Done),
				activity(messageText, OptimusActivityState.Active),
				...run.activity.slice(0, 4)
			]
		};
		this.runs.set(runId, updated);

		const transcript = this.transcripts.get(runId);
		this.transcripts.set(runId, {
			runId,
			messages: [
				...(transcript?.messages ?? []),
				message('user', messageText),
				message('agent', 'Follow-up queued for the future chat bridge adapter.')
			]
		});

		return updated;
	}

	async stopRun(runId: string): Promise<IOptimusRun> {
		const run = this.requireRun(runId);
		const updated = {
			...run,
			status: OptimusRunStatus.Canceled,
			capabilities: capabilitiesForStatus(OptimusRunStatus.Canceled),
			activity: [activity('Stopped by user', OptimusActivityState.Failed), ...run.activity.slice(0, 5)]
		};
		this.runs.set(runId, updated);
		return updated;
	}

	async retryRun(runId: string): Promise<IOptimusRun> {
		const run = this.requireRun(runId);
		const updated = {
			...run,
			status: OptimusRunStatus.Running,
			capabilities: capabilitiesForStatus(OptimusRunStatus.Running),
			activity: [activity('Retry started', OptimusActivityState.Active), ...run.activity.slice(0, 5)]
		};
		this.runs.set(runId, updated);
		return updated;
	}

	async reviewRun(runId: string): Promise<IOptimusRun> {
		const run = this.requireRun(runId);
		const updated = {
			...run,
			activity: [activity('Review opened', OptimusActivityState.Done), ...run.activity.slice(0, 5)]
		};
		this.runs.set(runId, updated);
		return updated;
	}

	async applyRun(runId: string): Promise<IOptimusRun> {
		const run = this.requireRun(runId);
		const updated = {
			...run,
			applyStateLabel: 'applied',
			status: OptimusRunStatus.Done,
			capabilities: capabilitiesForStatus(OptimusRunStatus.Done),
			activity: [activity('Changes applied', OptimusActivityState.Done), ...run.activity.slice(0, 5)]
		};
		this.runs.set(runId, updated);
		return updated;
	}

	async openWorktree(runId: string): Promise<IOptimusRun> {
		const run = this.requireRun(runId);
		const updated = {
			...run,
			activity: [activity('Worktree opened', OptimusActivityState.Done), ...run.activity.slice(0, 5)]
		};
		this.runs.set(runId, updated);
		return updated;
	}

	async openTranscript(runId: string): Promise<IOptimusTranscript> {
		this.requireRun(runId);
		return this.transcripts.get(runId) ?? { runId, messages: [] };
	}

	private requireRun(runId: string): IOptimusRun {
		const run = this.runs.get(runId);
		if (!run) {
			throw new Error(`Unknown Optimus run: ${runId}`);
		}
		return run;
	}
}

function titleFromTask(task: string): string {
	const title = task
		.trim()
		.split(/\s+/)
		.slice(0, 5)
		.join(' ');

	return title || 'New Optimus run';
}

function activity(text: string, state: OptimusActivityState): IOptimusActivityEvent {
	return {
		id: `${Date.now()}-${Math.random()}`,
		text,
		state,
		timestamp: Date.now()
	};
}

function capabilitiesForStatus(status: OptimusRunStatus) {
	return {
		canStop: status === OptimusRunStatus.Running || status === OptimusRunStatus.Queued,
		canRetry: status === OptimusRunStatus.Error || status === OptimusRunStatus.Canceled,
		canReview: status === OptimusRunStatus.Done,
		canApply: status === OptimusRunStatus.Done,
		canOpenWorktree: status === OptimusRunStatus.Running || status === OptimusRunStatus.Blocked || status === OptimusRunStatus.Done,
		canDismiss: status === OptimusRunStatus.Done || status === OptimusRunStatus.Error || status === OptimusRunStatus.Canceled,
		canQuickChat: status !== OptimusRunStatus.Canceled
	};
}

function message(author: 'user' | 'agent' | 'system', text: string) {
	return {
		id: `${Date.now()}-${Math.random()}`,
		author,
		text,
		timestamp: Date.now()
	};
}
