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

export interface IJarvisBackgroundSelectionResult {
	readonly accepted?: boolean;
	readonly path?: string;
	readonly uri?: string;
	readonly mediaKind?: 'image' | 'video';
	readonly error?: string;
}

export interface IJarvisVoiceToolCall {
	readonly callId?: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
}

export interface IJarvisVoiceTranscriptionResult {
	readonly accepted?: boolean;
	readonly transcript?: string;
	readonly toolCalls?: readonly IJarvisVoiceToolCall[];
	readonly error?: string;
}

export interface IJarvisCommandInterpretationResult {
	readonly accepted?: boolean;
	readonly text?: string;
	readonly toolCalls?: readonly IJarvisVoiceToolCall[];
	readonly error?: string;
}

export interface IJarvisBridge {
	readonly onTerminalData: (listener: (event: IJarvisTerminalDataEvent) => void) => { dispose(): void };
	readonly onTerminalExit: (listener: (event: IJarvisTerminalExitEvent) => void) => { dispose(): void };
	openTerminal(slotId: string, terminalName: string, cwd?: string): Promise<void>;
	writeTerminal(slotId: string, data: string): Promise<void>;
	resizeTerminal(slotId: string, cols: number, rows: number): Promise<void>;
	disposeTerminal(slotId: string): Promise<void>;
	selectWorkspaceFolder(currentPath?: string): Promise<IJarvisWorkspaceSelectionResult>;
	selectBackgroundFile(currentPath?: string): Promise<IJarvisBackgroundSelectionResult>;
	transcribeVoice(audio: Uint8Array, mimeType: string, systemPrompt: string, tools: readonly unknown[]): Promise<IJarvisVoiceTranscriptionResult>;
	interpretCommand(text: string, systemPrompt: string, tools: readonly unknown[]): Promise<IJarvisCommandInterpretationResult>;
	openEditor(): Promise<void>;
	openAgents(): Promise<void>;
	openJarvis(): Promise<void>;
}
