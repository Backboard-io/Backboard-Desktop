/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcRenderer } from '../../base/parts/sandbox/electron-browser/globals.js';
import { IJarvisBackgroundSelectionResult, IJarvisBridge, IJarvisCommandInterpretationResult, IJarvisCommandResult, IJarvisTerminalDataEvent, IJarvisTerminalExitEvent, IJarvisVoiceTranscriptionResult, IJarvisWorkspaceSelectionResult } from '../common/jarvisTypes.js';

export class ElectronJarvisBridge implements IJarvisBridge {

	onTerminalData(listener: (event: IJarvisTerminalDataEvent) => void): { dispose(): void } {
		const handler = (_event: unknown, ...args: unknown[]) => {
			const event = args[0];
			if (isTerminalDataEvent(event)) {
				listener(event);
			}
		};
		ipcRenderer.on('vscode:jarvisTerminalData', handler);
		return { dispose: () => ipcRenderer.removeListener('vscode:jarvisTerminalData', handler) };
	}

	onTerminalExit(listener: (event: IJarvisTerminalExitEvent) => void): { dispose(): void } {
		const handler = (_event: unknown, ...args: unknown[]) => {
			const event = args[0];
			if (isTerminalExitEvent(event)) {
				listener(event);
			}
		};
		ipcRenderer.on('vscode:jarvisTerminalExit', handler);
		return { dispose: () => ipcRenderer.removeListener('vscode:jarvisTerminalExit', handler) };
	}

	async openTerminal(slotId: string, terminalName: string, cwd?: string): Promise<void> {
		await this.sendTerminalCommand({ type: 'openTerminal', slotId, terminalName, cwd });
	}

	async writeTerminal(slotId: string, data: string): Promise<void> {
		await this.sendTerminalCommand({ type: 'writeTerminal', slotId, data });
	}

	async resizeTerminal(slotId: string, cols: number, rows: number): Promise<void> {
		await this.sendTerminalCommand({ type: 'resizeTerminal', slotId, cols, rows });
	}

	async disposeTerminal(slotId: string): Promise<void> {
		await this.sendTerminalCommand({ type: 'disposeTerminal', slotId });
	}

	async selectWorkspaceFolder(currentPath?: string): Promise<IJarvisWorkspaceSelectionResult> {
		const result = await ipcRenderer.invoke('vscode:jarvisSelectWorkspaceFolder', currentPath) as IJarvisWorkspaceSelectionResult | undefined;
		if (!result?.accepted) {
			return { accepted: false, error: result?.error };
		}
		return result;
	}

	async selectBackgroundFile(currentPath?: string): Promise<IJarvisBackgroundSelectionResult> {
		const result = await ipcRenderer.invoke('vscode:jarvisSelectBackgroundFile', currentPath) as IJarvisBackgroundSelectionResult | undefined;
		if (!result?.accepted) {
			return { accepted: false, error: result?.error };
		}
		return result;
	}

	async transcribeVoice(audio: Uint8Array, mimeType: string, systemPrompt: string, tools: readonly unknown[]): Promise<IJarvisVoiceTranscriptionResult> {
		const result = await ipcRenderer.invoke('vscode:jarvisVoiceTranscribe', {
			audio: Array.from(audio),
			mimeType,
			systemPrompt,
			tools
		}) as IJarvisVoiceTranscriptionResult | undefined;
		if (!result?.accepted) {
			return { accepted: false, error: result?.error ?? 'Backboard voice transcription failed.' };
		}
		return result;
	}

	async interpretCommand(text: string, systemPrompt: string, tools: readonly unknown[]): Promise<IJarvisCommandInterpretationResult> {
		const result = await ipcRenderer.invoke('vscode:jarvisInterpretCommand', {
			text,
			systemPrompt,
			tools
		}) as IJarvisCommandInterpretationResult | undefined;
		if (!result?.accepted) {
			return { accepted: false, error: result?.error ?? 'Backboard command interpretation failed.' };
		}
		return result;
	}

	async openEditor(): Promise<void> {
		await this.switchWindowKind('editor');
	}

	async openAgents(): Promise<void> {
		await this.switchWindowKind('agents');
	}

	async openOptimus(): Promise<void> {
		await this.switchWindowKind('optimus');
	}

	async openJarvis(): Promise<void> {
		await this.switchWindowKind('jarvis');
	}

	private async sendTerminalCommand(command: Record<string, unknown>): Promise<void> {
		const result = await ipcRenderer.invoke('vscode:jarvisTerminalCommand', command) as IJarvisCommandResult | undefined;
		if (!result?.accepted) {
			throw new Error(result?.error ?? 'Jarvis terminal command was rejected.');
		}
	}

	private async switchWindowKind(target: 'editor' | 'agents' | 'optimus' | 'jarvis'): Promise<void> {
		const result = await ipcRenderer.invoke('vscode:jarvisSwitchWindowKind', target) as IJarvisCommandResult | undefined;
		if (!result?.accepted) {
			throw new Error(result?.error ?? `Could not switch to ${target}.`);
		}
	}
}

function isTerminalDataEvent(value: unknown): value is IJarvisTerminalDataEvent {
	return typeof value === 'object'
		&& value !== null
		&& typeof (value as { slotId?: unknown }).slotId === 'string'
		&& typeof (value as { data?: unknown }).data === 'string';
}

function isTerminalExitEvent(value: unknown): value is IJarvisTerminalExitEvent {
	return typeof value === 'object'
		&& value !== null
		&& typeof (value as { slotId?: unknown }).slotId === 'string';
}
