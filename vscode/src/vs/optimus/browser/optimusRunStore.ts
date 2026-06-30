/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { IOptimusChatBridge } from '../common/optimusChatBridge.js';
import { IOptimusRun, IOptimusRunRequest, IOptimusTranscript, OptimusRunStatus } from '../common/optimusTypes.js';

export class OptimusRunStore extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _runs = new Map<string, IOptimusRun>();
	private _selectedRunId: string | undefined;

	constructor(private readonly chatBridge: IOptimusChatBridge) {
		super();
	}

	get runs(): readonly IOptimusRun[] {
		return Array.from(this._runs.values()).sort((a, b) => statusRank(a.status) - statusRank(b.status));
	}

	get selectedRun(): IOptimusRun | undefined {
		return this._selectedRunId ? this._runs.get(this._selectedRunId) : undefined;
	}

	selectRun(runId: string | undefined): void {
		this._selectedRunId = runId;
		this._onDidChange.fire();
	}

	addRun(run: IOptimusRun): void {
		this._runs.set(run.id, run);
		this._selectedRunId = run.id;
		this._onDidChange.fire();
	}

	updateRun(runId: string, updates: Partial<IOptimusRun>): void {
		const existing = this._runs.get(runId);
		if (!existing) {
			return;
		}
		this._runs.set(runId, { ...existing, ...updates });
		this._onDidChange.fire();
	}

	async createRun(request: IOptimusRunRequest): Promise<void> {
		const run = await this.chatBridge.createRun(request);
		this._runs.set(run.id, run);
		this._selectedRunId = run.id;
		this._onDidChange.fire();
	}

	async sendMessage(runId: string, message: string, workspace?: string): Promise<void> {
		this._runs.set(runId, await this.chatBridge.sendMessage(runId, message, workspace));
		this._onDidChange.fire();
	}

	async stopRun(runId: string): Promise<void> {
		this._runs.set(runId, await this.chatBridge.stopRun(runId));
		this._onDidChange.fire();
	}

	async retryRun(runId: string): Promise<void> {
		this._runs.set(runId, await this.chatBridge.retryRun(runId));
		this._onDidChange.fire();
	}

	async reviewRun(runId: string): Promise<void> {
		if (!this.chatBridge.reviewRun) {
			return;
		}
		this._runs.set(runId, await this.chatBridge.reviewRun(runId));
		this._onDidChange.fire();
	}

	async applyRun(runId: string): Promise<void> {
		if (!this.chatBridge.applyRun) {
			return;
		}
		this._runs.set(runId, await this.chatBridge.applyRun(runId));
		this._onDidChange.fire();
	}

	async openWorktree(runId: string): Promise<void> {
		if (!this.chatBridge.openWorktree) {
			return;
		}
		this._runs.set(runId, await this.chatBridge.openWorktree(runId));
		this._onDidChange.fire();
	}

	dismissRun(runId: string): void {
		this._runs.delete(runId);
		if (this._selectedRunId === runId) {
			this._selectedRunId = undefined;
		}
		this._onDidChange.fire();
	}

	async openTranscript(runId: string): Promise<IOptimusTranscript> {
		return this.chatBridge.openTranscript(runId);
	}
}

function statusRank(status: OptimusRunStatus): number {
	switch (status) {
		case OptimusRunStatus.Blocked:
			return 0;
		case OptimusRunStatus.Running:
			return 1;
		case OptimusRunStatus.Queued:
			return 2;
		case OptimusRunStatus.Done:
			return 3;
		case OptimusRunStatus.Error:
			return 4;
		case OptimusRunStatus.Canceled:
			return 5;
	}
}
