/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISession } from '../../../services/sessions/common/session.js';

export type SandboxWorkspaceChangeType = 'added' | 'modified' | 'deleted';

export interface ISandboxWorkspaceChange {
	readonly uri: URI;
	readonly type: SandboxWorkspaceChangeType;
}

export interface ISandboxWorkspaceChangeDetails {
	readonly change: ISandboxWorkspaceChange;
	readonly beforeContent: string | undefined;
	readonly afterContent: string | undefined;
	readonly hasBeforeContent: boolean;
	readonly hasAfterContent: boolean;
}

export const ISandboxWorkspaceChangesService = createDecorator<ISandboxWorkspaceChangesService>('sandboxWorkspaceChangesService');

export interface ISandboxWorkspaceChangesService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	ensureBaseline(session: ISession | undefined): Promise<void>;
	getChanges(session: ISession | undefined): Promise<readonly ISandboxWorkspaceChange[]>;
	getChangeDetails(session: ISession | undefined, uri: URI): Promise<ISandboxWorkspaceChangeDetails | undefined>;
	reset(session: ISession | undefined): void;
	signalChanged(): void;
}
