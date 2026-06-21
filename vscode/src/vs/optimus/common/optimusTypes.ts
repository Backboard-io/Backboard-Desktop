/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const enum OptimusProvider {
	Backboard = 'backboard',
	Copilot = 'copilot'
}

export const enum OptimusRunStatus {
	Queued = 'queued',
	Running = 'running',
	Blocked = 'blocked',
	Done = 'done',
	Error = 'error',
	Canceled = 'canceled'
}

export const enum OptimusActivityState {
	Active = 'active',
	Done = 'done',
	Waiting = 'waiting',
	Failed = 'failed',
	Muted = 'muted'
}

export interface IOptimusActivityEvent {
	readonly id: string;
	readonly text: string;
	readonly state: OptimusActivityState;
	readonly timestamp: number;
}

export interface IOptimusRun {
	readonly id: string;
	readonly title: string;
	readonly provider: OptimusProvider;
	readonly status: OptimusRunStatus;
	readonly task: string;
	readonly command?: string;
	readonly activity: readonly IOptimusActivityEvent[];
	readonly touchedFiles: readonly string[];
	readonly filesChanged?: number;
	readonly model: string;
	readonly cost?: string;
	readonly chatRef?: string;
	readonly workspace?: string;
	readonly worktreeLabel?: string;
	readonly branchLabel?: string;
	readonly applyStateLabel?: string;
	readonly blockedReason?: string;
	readonly capabilities: IOptimusRunCapabilities;
}

export interface IOptimusRunCapabilities {
	readonly canStop: boolean;
	readonly canRetry: boolean;
	readonly canReview: boolean;
	readonly canApply: boolean;
	readonly canOpenWorktree: boolean;
	readonly canDismiss: boolean;
	readonly canQuickChat: boolean;
}

export interface IOptimusRunRequest {
	readonly task: string;
	readonly provider: OptimusProvider;
	readonly workspace?: string;
}

export interface IOptimusTranscriptMessage {
	readonly id: string;
	readonly author: 'user' | 'agent' | 'system';
	readonly text: string;
	readonly timestamp: number;
}

export interface IOptimusTranscript {
	readonly runId: string;
	readonly messages: readonly IOptimusTranscriptMessage[];
}
