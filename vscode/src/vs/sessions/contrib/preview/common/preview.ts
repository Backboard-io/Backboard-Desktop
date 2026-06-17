/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISession } from '../../../services/sessions/common/session.js';

export const SESSIONS_PREVIEW_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.previewContainer';
export const SESSIONS_PREVIEW_VIEW_ID = 'sessions.preview';

export type SandboxPreviewKind = 'static-html' | 'dev-server';
export type SandboxPreviewStatus = 'empty' | 'detected' | 'starting' | 'ready' | 'error';

export interface ISandboxPreviewCandidate {
	readonly kind: SandboxPreviewKind;
	readonly title: string;
	readonly workspaceRoot: URI;
	readonly cwd: URI;
	readonly entry?: URI;
	readonly command?: string;
	readonly framework?: string;
	readonly url?: string;
	readonly confidence: number;
}

export interface ISandboxPreviewState {
	readonly status: SandboxPreviewStatus;
	readonly candidate?: ISandboxPreviewCandidate;
	readonly url?: string;
	readonly error?: string;
}

export const EMPTY_SANDBOX_PREVIEW_STATE: ISandboxPreviewState = { status: 'empty' };

export const ISandboxPreviewService = createDecorator<ISandboxPreviewService>('sandboxPreviewService');

export interface ISandboxPreviewService {
	readonly _serviceBrand: undefined;

	getState(sessionResource: URI | undefined): IObservable<ISandboxPreviewState>;
	detect(session: ISession): Promise<ISandboxPreviewCandidate | undefined>;
	setCandidate(session: ISession, candidate: ISandboxPreviewCandidate | undefined): void;
	prepare(session: ISession): Promise<void>;
	start(session: ISession): Promise<void>;
	open(session: ISession): Promise<void>;
	refresh(session: ISession): Promise<void>;
	fail(session: ISession, error: unknown): void;
}
