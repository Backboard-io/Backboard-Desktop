/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOptimusRun, IOptimusRunRequest, IOptimusTranscript } from './optimusTypes.js';

export interface IOptimusChatBridge {
	createRun(request: IOptimusRunRequest): Promise<IOptimusRun>;
	sendMessage(runId: string, message: string, workspace?: string): Promise<IOptimusRun>;
	stopRun(runId: string): Promise<IOptimusRun>;
	retryRun(runId: string): Promise<IOptimusRun>;
	reviewRun?(runId: string): Promise<IOptimusRun>;
	applyRun?(runId: string): Promise<IOptimusRun>;
	openWorktree?(runId: string): Promise<IOptimusRun>;
	openTranscript(runId: string): Promise<IOptimusTranscript>;
}
