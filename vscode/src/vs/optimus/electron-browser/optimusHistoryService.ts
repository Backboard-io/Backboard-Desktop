/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcRenderer } from '../../base/parts/sandbox/electron-browser/globals.js';
import { IOptimusHistoryEntry, IOptimusHistoryProvider, IOptimusNavigationProvider, IOptimusWorkspaceEntry } from '../common/optimusHistory.js';

export class ElectronOptimusHistoryProvider implements IOptimusHistoryProvider {

	async listBackboardHistory(): Promise<readonly IOptimusHistoryEntry[]> {
		const result = await ipcRenderer.invoke('vscode:optimusBackboardHistory');
		return Array.isArray(result) ? result.filter(isOptimusHistoryEntry) : [];
	}

	async listBackboardWorkspaces(): Promise<readonly IOptimusWorkspaceEntry[]> {
		const result = await ipcRenderer.invoke('vscode:optimusBackboardWorkspaces');
		return Array.isArray(result) ? result.filter(isOptimusWorkspaceEntry) : [];
	}

	async openBackboardPanel(): Promise<void> {
		await sendBackboardPanelCommand({ type: 'showChat' });
	}

	async openBackboardHistory(): Promise<void> {
		await sendBackboardPanelCommand({ type: 'showHistory' });
	}

	async openBackboardHistoryEntry(id: string): Promise<void> {
		await sendBackboardPanelCommand({ type: 'openHistoryEntry', chatId: id });
	}

	async openBackboardNewChat(workspace?: string): Promise<void> {
		await sendBackboardPanelCommand({ type: 'newChat', workspace });
	}

	async sendBackboardPrompt(prompt: string, chatId?: string, workspace?: string): Promise<void> {
		await sendBackboardPanelCommand({ type: 'sendPrompt', prompt, chatId, workspace, newChat: !chatId });
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

function isOptimusWorkspaceEntry(value: unknown): value is IOptimusWorkspaceEntry {
	return typeof value === 'object'
		&& value !== null
		&& !Array.isArray(value)
		&& typeof (value as { id?: unknown }).id === 'string'
		&& typeof (value as { label?: unknown }).label === 'string';
}
