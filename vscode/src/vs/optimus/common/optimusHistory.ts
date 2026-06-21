/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IOptimusHistoryProvider {
	listBackboardHistory(): Promise<readonly IOptimusHistoryEntry[]>;
	listBackboardWorkspaces?(): Promise<readonly IOptimusWorkspaceEntry[]>;
	openBackboardHistory?(): Promise<void>;
	openBackboardHistoryEntry?(id: string): Promise<void>;
	openBackboardNewChat?(workspace?: string): Promise<void>;
	sendBackboardPrompt?(prompt: string, chatId?: string, workspace?: string): Promise<void>;
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
