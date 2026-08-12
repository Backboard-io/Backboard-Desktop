/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';

export interface BridgeEvent {
	readonly type: string;
	readonly requestId: string;
	readonly sessionId?: string;
	readonly message?: string;
	readonly text?: string;
	readonly models?: BridgeModel[];
	readonly tools?: unknown[];
	readonly toolCalls?: unknown[];
	readonly threadId?: string;
	readonly runId?: string;
	readonly stopReason?: string;
	readonly usage?: unknown;
	readonly chunk?: unknown;
	readonly assistantId?: string;
	readonly output?: unknown;
	readonly status?: string;
	readonly name?: string;
	readonly data?: unknown;
}

export interface BridgeModel {
	readonly provider: string;
	readonly name: string;
	readonly modelType?: string;
	readonly displayName?: string;
	readonly contextLimit?: number;
	readonly supportsThinking?: boolean;
	readonly supportsVision?: boolean;
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

export interface ModelCacheEntry {
	readonly env: string;
	readonly version?: number;
	readonly ideVersion?: string;
	readonly apiUrl?: string;
	readonly fetchedAt: number;
	readonly models: BridgeModel[];
}

export interface ToolCacheEntry {
	readonly env: string;
	readonly version?: number;
	readonly ideVersion?: string;
	readonly apiUrl?: string;
	readonly mode: string;
	readonly fetchedAt: number;
	readonly tools: unknown[];
}

export interface PendingRequest {
	readonly events: BridgeEvent[];
	readonly onEvent?: (event: BridgeEvent) => void | Promise<void>;
	readonly resetTimeout: () => void;
	readonly resolve: (events: BridgeEvent[]) => void;
	readonly reject: (error: Error) => void;
}

export interface ToolResultRequest {
	readonly threadId?: string;
	readonly runId?: string;
	readonly toolCalls: unknown[];
}

export interface FileChangePayload {
	readonly path: string;
	readonly status: 'edited' | 'created' | 'deleted';
	readonly added: number;
	readonly removed: number;
	readonly previewLines: readonly { readonly type: 'add' | 'remove' | 'context'; readonly text: string }[];
}

export interface VoiceAttachment {
	readonly data: readonly number[];
	readonly fileName: string;
	readonly mimeType: string;
}

export interface ImageAttachment {
	readonly data: readonly number[];
	readonly fileName: string;
	readonly mimeType: string;
}

export interface FileAttachment {
	readonly data: readonly number[];
	readonly fileName: string;
	readonly mimeType: string;
}

export interface BackboardAttachment {
	readonly data: readonly number[];
	readonly fileName: string;
	readonly mimeType: string;
}

export interface PanelOptions {
	readonly provider?: string;
	readonly model?: string;
	readonly mode?: string;
	readonly intensity?: string;
	readonly webSearch?: string;
	readonly imageGeneration?: string;
	readonly voiceMode?: string;
	readonly mcpFigma?: boolean;
	readonly mcpNotion?: boolean;
	readonly mcpGoogle?: boolean;
	readonly authenticated?: boolean;
}

export interface PanelPersistedState {
	readonly activeView?: string;
	readonly activeHistoryId?: string;
	readonly promptQueue?: unknown[];
	readonly currentWorkspace?: string;
	readonly historyEntries?: unknown[];
	readonly savedAt?: number;
}

export interface PanelStateStore {
	readonly latest?: PanelPersistedState;
	readonly byWorkspace?: Record<string, PanelPersistedState>;
}

export interface PanelThreadFile {
	readonly version?: number;
	readonly source?: string;
	readonly workspace?: string;
	readonly savedAt?: number;
	readonly entry?: unknown;
}

export interface BackboardConfigJson {
	readonly [key: string]: unknown;
	readonly env?: string;
	readonly api_key?: string;
	readonly env_keys?: Record<string, string>;
}

export interface BackboardOAuthTokens {
	readonly api_key?: string | null;
	readonly apiKey?: string | null;
	readonly access_token?: string;
	readonly refresh_token?: string;
	readonly token_type?: string;
	readonly expires_in?: number;
	readonly scope?: string;
	readonly id_token?: string | null;
	readonly assistant_id?: string | null;
	readonly backboard_api_key?: string | null;
	readonly personal_api_key?: string | null;
	readonly selected_client_name?: string | null;
}

export interface BackboardDeviceCodeResponse {
	readonly device_code: string;
	readonly user_code: string;
	readonly verification_uri: string;
	readonly verification_uri_complete: string;
	readonly expires_in: number;
	readonly interval: number;
}

export interface BackboardOAuthSaveResult {
	readonly apiKeySaved: boolean;
	readonly assistantId?: string;
}

export interface ResponseSink {
	markdown(value: string | vscode.MarkdownString): void;
	progress(value: string): void;
	event?(type: string, payload: unknown): void;
}
