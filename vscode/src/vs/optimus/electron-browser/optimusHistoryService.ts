/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcRenderer } from '../../base/parts/sandbox/electron-browser/globals.js';
import { IOptimusBackboardMetadata, IOptimusBackboardModel, IOptimusHistoryEntry, IOptimusHistoryProvider, IOptimusLiveState, IOptimusNavigationProvider, IOptimusPromptOptions, IOptimusWorkspaceEntry } from '../common/optimusHistory.js';

export class ElectronOptimusHistoryProvider implements IOptimusHistoryProvider {

	async listBackboardHistory(): Promise<readonly IOptimusHistoryEntry[]> {
		const result = await ipcRenderer.invoke('vscode:optimusBackboardHistory');
		return Array.isArray(result) ? result.filter(isOptimusHistoryEntry) : [];
	}

	async readBackboardLiveState(): Promise<IOptimusLiveState | undefined> {
		const result = await ipcRenderer.invoke('vscode:optimusBackboardLiveState');
		return isOptimusLiveState(result) ? result : undefined;
	}

	async listBackboardWorkspaces(): Promise<readonly IOptimusWorkspaceEntry[]> {
		const result = await ipcRenderer.invoke('vscode:optimusBackboardWorkspaces');
		return Array.isArray(result) ? result.filter(isOptimusWorkspaceEntry) : [];
	}

	async readBackboardMetadata(): Promise<IOptimusBackboardMetadata | undefined> {
		const result = await ipcRenderer.invoke('vscode:optimusBackboardMetadata');
		return isOptimusBackboardMetadata(result) ? result : undefined;
	}

	async sendBackboardPrompt(prompt: string, chatId?: string, workspace?: string, options?: IOptimusPromptOptions): Promise<void> {
		await sendBackboardPanelCommand({ type: 'sendPrompt', prompt, chatId, workspace, options, newChat: !chatId });
	}

	async cancelBackboardPrompt(): Promise<void> {
		await sendBackboardPanelCommand({ type: 'cancel' });
	}
}

export class ElectronOptimusNavigationProvider implements IOptimusNavigationProvider {

	async openEditor(): Promise<void> {
		await switchWindowKind('editor');
	}

	async openAgents(): Promise<void> {
		await switchWindowKind('agents');
	}

	async openOptimus(): Promise<void> {
		await switchWindowKind('optimus');
	}

	async openJarvis(): Promise<void> {
		await switchWindowKind('jarvis');
	}
}

async function sendBackboardPanelCommand(command: Record<string, unknown>): Promise<void> {
	const result = await ipcRenderer.invoke('vscode:optimusBackboardCommand', {
		id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
		...command
	}) as { readonly accepted?: boolean; readonly error?: string } | undefined;
	if (!result?.accepted) {
		throw new Error(result?.error ?? 'Backboard editor panel did not accept the Optimus command.');
	}
}

async function switchWindowKind(target: 'editor' | 'agents' | 'optimus' | 'jarvis'): Promise<void> {
	const result = await ipcRenderer.invoke('vscode:optimusSwitchWindowKind', target) as { readonly accepted?: boolean; readonly error?: string } | undefined;
	if (!result?.accepted) {
		throw new Error(result?.error ?? `Could not switch to ${target}.`);
	}
}

function isOptimusHistoryEntry(value: unknown): value is IOptimusHistoryEntry {
	return typeof value === 'object'
		&& value !== null
		&& !Array.isArray(value)
		&& typeof (value as { id?: unknown }).id === 'string'
		&& Array.isArray((value as { messages?: unknown }).messages);
}

function isOptimusLiveState(value: unknown): value is IOptimusLiveState {
	return typeof value === 'object'
		&& value !== null
		&& !Array.isArray(value)
		&& typeof (value as { id?: unknown }).id === 'string'
		&& Array.isArray((value as { messages?: unknown }).messages);
}

function isOptimusWorkspaceEntry(value: unknown): value is IOptimusWorkspaceEntry {
	return typeof value === 'object'
		&& value !== null
		&& !Array.isArray(value)
		&& typeof (value as { id?: unknown }).id === 'string'
		&& typeof (value as { label?: unknown }).label === 'string';
}

function isOptimusBackboardMetadata(value: unknown): value is IOptimusBackboardMetadata {
	return typeof value === 'object'
		&& value !== null
		&& !Array.isArray(value)
		&& Array.isArray((value as { models?: unknown }).models)
		&& (value as { models: unknown[] }).models.every(isOptimusBackboardModel);
}

function isOptimusBackboardModel(value: unknown): value is IOptimusBackboardModel {
	return typeof value === 'object'
		&& value !== null
		&& !Array.isArray(value)
		&& typeof (value as { provider?: unknown }).provider === 'string'
		&& typeof (value as { name?: unknown }).name === 'string';
}
