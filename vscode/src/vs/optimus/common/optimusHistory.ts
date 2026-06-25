/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IOptimusHistoryProvider {
	listBackboardHistory(): Promise<readonly IOptimusHistoryEntry[]>;
	readBackboardLiveState?(): Promise<IOptimusLiveState | undefined>;
	listBackboardWorkspaces?(): Promise<readonly IOptimusWorkspaceEntry[]>;
	readBackboardMetadata?(): Promise<IOptimusBackboardMetadata | undefined>;
	sendBackboardPrompt?(prompt: string, chatId?: string, workspace?: string, options?: IOptimusPromptOptions): Promise<void>;
	cancelBackboardPrompt?(): Promise<void>;
}

export interface IOptimusPromptOptions {
	readonly provider?: string;
	readonly model?: string;
	readonly voiceMode?: string;
}

export interface IOptimusBackboardMetadata {
	readonly settings?: IOptimusPromptOptions & { readonly authenticated?: boolean };
	readonly models: readonly IOptimusBackboardModel[];
	readonly updatedAt?: number;
}

export interface IOptimusBackboardModel {
	readonly provider: string;
	readonly name: string;
	readonly displayName?: string;
	readonly modelType?: string;
	readonly contextLimit?: number;
	readonly supportsThinking?: boolean;
	readonly pricing?: string;
	readonly inputPrice?: number;
	readonly outputPrice?: number;
	readonly inputPricePerMillion?: number;
	readonly outputPricePerMillion?: number;
	readonly inputCostPer1mTokens?: number;
	readonly outputCostPer1mTokens?: number;
	readonly promptPrice?: number;
	readonly completionPrice?: number;
}

export interface IOptimusNavigationProvider {
	openEditor(): Promise<void>;
	openAgents(): Promise<void>;
	openOptimus(): Promise<void>;
	openJarvis(): Promise<void>;
}

export interface IOptimusWorkspaceEntry {
	readonly id: string;
	readonly label: string;
	readonly path?: string;
	readonly chatCount?: number;
	readonly lastActiveAt?: number;
}

export interface IOptimusHistoryEntry {
	readonly id: string;
	readonly source?: string;
	readonly title?: string;
	readonly prompt?: string;
	readonly status?: string;
	readonly startedAt?: number;
	readonly updatedAt?: number;
	readonly currentWorkspace?: string;
	readonly messages: readonly IOptimusHistoryMessage[];
	readonly fileChanges: readonly IOptimusHistoryFileChange[];
}

export interface IOptimusHistoryMessage {
	readonly role: string;
	readonly content: string;
}

export interface IOptimusHistoryFileChange {
	readonly path: string;
	readonly added?: number;
	readonly removed?: number;
}

export interface IOptimusLiveState {
	readonly id: string;
	readonly chatId?: string;
	readonly prompt?: string;
	readonly status?: string;
	readonly statusKey?: string;
	readonly running?: boolean;
	readonly startedAt?: number;
	readonly updatedAt?: number;
	readonly currentWorkspace?: string;
	readonly messages: readonly IOptimusHistoryMessage[];
	readonly fileChanges?: readonly IOptimusHistoryFileChange[];
}
