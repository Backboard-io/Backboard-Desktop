/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A dirty text buffer, stored separately from its on-disk recovery snapshot. */
export interface IAgentRewindBuffer {
	readonly path: string;
	readonly content: string;
	readonly encoding?: string;
}

/** Local host extension; generated AHP wire types remain unchanged. */
export type AgentRewindRequest =
	| { readonly operation: 'prepare'; readonly retainedTurnId?: string }
	| { readonly operation: 'commit'; readonly transactionId: string; readonly buffers: readonly IAgentRewindBuffer[] }
	| { readonly operation: 'recover'; readonly transactionId?: string }
	| { readonly operation: 'inspectRecovery' }
	| { readonly operation: 'resume' }
	| { readonly operation: 'acknowledge'; readonly transactionId: string };

export interface IAgentRewindResult {
	readonly transactionId: string;
	readonly status: 'prepared' | 'applying' | 'committed' | 'recovering' | 'recovered';
	readonly paths: readonly string[];
	readonly backupId?: string;
	readonly headBackupId?: string;
	readonly buffers: readonly IAgentRewindBuffer[];
	readonly activeCount: number;
}
