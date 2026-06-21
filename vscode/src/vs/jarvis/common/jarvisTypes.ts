/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IJarvisTerminalSlot {
	readonly id: string;
	readonly name: string;
}

export interface IJarvisTerminalDataEvent {
	readonly slotId: string;
	readonly data: string;
}

export interface IJarvisTerminalExitEvent {
	readonly slotId: string;
	readonly exitCode?: number;
	readonly signal?: number;
}

export interface IJarvisCommandResult {
	readonly accepted?: boolean;
	readonly slotId?: string;
	readonly error?: string;
}

export interface IJarvisWorkspaceSelectionResult {
	readonly accepted?: boolean;
	readonly path?: string;
	readonly error?: string;
}

export interface IJarvisVoiceTranscriptionResult {
	readonly accepted?: boolean;
	readonly transcript?: string;
	readonly error?: string;
}

export interface IJarvisBridge {
	readonly onTerminalData: (listener: (event: IJarvisTerminalDataEvent) => void) => { dispose(): void };
	readonly onTerminalExit: (listener: (event: IJarvisTerminalExitEvent) => void) => { dispose(): void };
	openTerminal(slotId: string, terminalName: string, cwd?: string): Promise<void>;
	writeTerminal(slotId: string, data: string): Promise<void>;
	disposeTerminal(slotId: string): Promise<void>;
	selectWorkspaceFolder(currentPath?: string): Promise<IJarvisWorkspaceSelectionResult>;
	transcribeVoice(audio: Uint8Array, mimeType: string, systemPrompt: string, tools: readonly unknown[]): Promise<IJarvisVoiceTranscriptionResult>;
	openEditor(): Promise<void>;
	openAgents(): Promise<void>;
	openOptimus(): Promise<void>;
	openJarvis(): Promise<void>;
}
