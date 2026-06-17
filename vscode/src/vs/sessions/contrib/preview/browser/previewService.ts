/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ResourceMap } from '../../../../base/common/map.js';
import { constObservable, IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { timeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorService, SIDE_GROUP } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { ISessionsTasksService, ITaskEntry } from '../../chat/browser/sessionsTasksService.js';
import { ISandboxPreviewCandidate, ISandboxPreviewService, ISandboxPreviewState, EMPTY_SANDBOX_PREVIEW_STATE } from '../common/preview.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { SandboxPreviewDetector } from './previewDetector.js';

export class SandboxPreviewService extends Disposable implements ISandboxPreviewService {
	declare readonly _serviceBrand: undefined;

	private readonly _states = new ResourceMap<ReturnType<typeof observableValue<ISandboxPreviewState>>>();
	private readonly _runningPreparations = new ResourceMap<{ key: string; promise: Promise<void> }>();
	private readonly _startedDevServers = new ResourceMap<string>();
	private readonly _detector: SandboxPreviewDetector;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ISessionsTasksService private readonly _sessionsTasksService: ISessionsTasksService,
		@IEditorService private readonly _editorService: IEditorService,
		@IBrowserViewWorkbenchService private readonly _browserViewService: IBrowserViewWorkbenchService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
	) {
		super();
		this._detector = instantiationService.createInstance(SandboxPreviewDetector);
	}

	getState(sessionResource: URI | undefined): IObservable<ISandboxPreviewState> {
		if (!sessionResource) {
			return constObservable(EMPTY_SANDBOX_PREVIEW_STATE);
		}
		return this._getState(sessionResource);
	}

	async detect(session: ISession): Promise<ISandboxPreviewCandidate | undefined> {
		return this._detector.detect(session);
	}

	setCandidate(session: ISession, candidate: ISandboxPreviewCandidate | undefined): void {
		const state = this._getState(session.resource);
		if (!candidate) {
			state.set(EMPTY_SANDBOX_PREVIEW_STATE, undefined);
			return;
		}

		const storedUrl = candidate.kind === 'dev-server'
			? this._sessionsTasksService.getBrowserUrl(candidate.workspaceRoot).get()
			: undefined;

		if (storedUrl) {
			state.set({
				status: 'ready',
				candidate,
				url: storedUrl,
			}, undefined);
			return;
		}

		state.set({ status: 'detected', candidate }, undefined);
	}

	async prepare(session: ISession): Promise<void> {
		const candidate = await this.detect(session);
		this.setCandidate(session, candidate);
		if (!candidate) {
			return;
		}
		await this._prepareCandidate(session, candidate);
	}

	async start(session: ISession): Promise<void> {
		const stateObs = this._getState(session.resource);
		const state = stateObs.get();
		const candidate = state.candidate;
		if (!candidate) {
			return;
		}

		await this._prepareCandidate(session, candidate);
		await this.open(session);
	}

	async open(session: ISession): Promise<void> {
		const stateObs = this._getState(session.resource);
		let state = stateObs.get();
		let candidate = state.candidate;
		if (!candidate) {
			await this.prepare(session);
			state = stateObs.get();
			candidate = state.candidate;
		}
		if (!candidate) {
			return;
		}

		if (state.status !== 'ready') {
			await this._prepareCandidate(session, candidate);
			state = stateObs.get();
		}

		const url = state.url ?? candidate.url ?? candidate.entry?.toString();
		if (!url) {
			this.fail(session, 'No preview URL was detected.');
			return;
		}

		if (candidate.kind === 'dev-server') {
			this._sessionsTasksService.setBrowserUrl(candidate.workspaceRoot, url);
		}

		stateObs.set({
			status: 'ready',
			candidate,
			url,
		}, undefined);
		await this._openIntegratedBrowser(url);
	}

	async refresh(session: ISession): Promise<void> {
		await this.prepare(session);
		const state = this._getState(session.resource).get();
		if (state.url) {
			await this._openIntegratedBrowser(state.url);
		}
	}

	fail(session: ISession, error: unknown): void {
		const current = this._getState(session.resource).get();
		this._getState(session.resource).set({
			status: 'error',
			candidate: current.candidate,
			url: current.url,
			error: error instanceof Error ? error.message : String(error),
		}, undefined);
	}

	private async _prepareCandidate(session: ISession, candidate: ISandboxPreviewCandidate): Promise<void> {
		const key = this._candidateKey(candidate);
		const running = this._runningPreparations.get(session.resource);
		if (running?.key === key) {
			await running.promise;
			return;
		}

		const promise = this._doPrepareCandidate(session, candidate, key);
		this._runningPreparations.set(session.resource, { key, promise });
		try {
			await promise;
		} finally {
			if (this._runningPreparations.get(session.resource)?.promise === promise) {
				this._runningPreparations.delete(session.resource);
			}
		}
	}

	private async _doPrepareCandidate(session: ISession, candidate: ISandboxPreviewCandidate, key: string): Promise<void> {
		const stateObs = this._getState(session.resource);
		if (candidate.kind === 'static-html') {
			const url = candidate.url ?? candidate.entry?.toString();
			if (!url) {
				this.fail(session, 'No preview URL was detected.');
				return;
			}
			stateObs.set({
				status: 'ready',
				candidate,
				url,
			}, undefined);
			await this._refreshKnownBrowser(url);
			return;
		}

		if (!candidate.command) {
			this.fail(session, 'No preview command was detected.');
			return;
		}

		const url = candidate.url ?? this._sessionsTasksService.getBrowserUrl(candidate.workspaceRoot).get() ?? 'http://localhost:3000';
		const startedKey = this._startedDevServers.get(candidate.workspaceRoot);
		if (startedKey === key) {
			this._sessionsTasksService.setBrowserUrl(candidate.workspaceRoot, url);
			stateObs.set({
				status: 'ready',
				candidate,
				url,
			}, undefined);
			await this._refreshKnownBrowser(url);
			return;
		}

		stateObs.set({ status: 'starting', candidate }, undefined);
		try {
			const task: ITaskEntry = {
				label: `Start Preview${candidate.framework ? ` (${candidate.framework})` : ''}`,
				type: 'shell',
				command: candidate.command,
			};
			await this._sessionsTasksService.runTask(task, session);
			this._startedDevServers.set(candidate.workspaceRoot, key);
			this._sessionsTasksService.setBrowserUrl(candidate.workspaceRoot, url);
			stateObs.set({
				status: 'ready',
				candidate,
				url,
			}, undefined);
			await this._refreshKnownBrowser(url);
		} catch (error) {
			this.fail(session, error);
		}
	}

	private _getState(sessionResource: URI): ReturnType<typeof observableValue<ISandboxPreviewState>> {
		let state = this._states.get(sessionResource);
		if (!state) {
			state = observableValue<ISandboxPreviewState>(this, EMPTY_SANDBOX_PREVIEW_STATE);
			this._states.set(sessionResource, state);
		}
		return state;
	}

	private _candidateKey(candidate: ISandboxPreviewCandidate): string {
		return [
			candidate.kind,
			candidate.workspaceRoot.toString(),
			candidate.cwd.toString(),
			candidate.entry?.toString() ?? '',
			candidate.command ?? '',
			candidate.url ?? '',
		].join('\n');
	}

	private async _refreshKnownBrowser(url: string): Promise<void> {
		const matchingEditor = [...this._browserViewService.getKnownBrowserViews().values()].find(editor => editor.url === url);
		if (matchingEditor) {
			matchingEditor.navigate(url);
		}
	}

	private async _openIntegratedBrowser(url: string): Promise<void> {
		await this._layoutService.whenRestored;
		let lastLayoutError: Error | undefined;
		for (let attempt = 0; attempt < 8; attempt++) {
			await timeout(attempt === 0 ? 0 : 250);
			try {
				await this._doOpenIntegratedBrowser(url);
				return;
			} catch (error) {
				if (!(error instanceof Error && error.message.includes('before first layout'))) {
					throw error;
				}
				lastLayoutError = error;
			}
		}
		throw lastLayoutError ?? new Error('Unable to open integrated browser.');
	}

	private async _doOpenIntegratedBrowser(url: string): Promise<void> {
		const matchingEditor = [...this._browserViewService.getKnownBrowserViews().values()].find(editor => editor.url === url);
		if (matchingEditor) {
			matchingEditor.navigate(url);
			await this._editorService.openEditor(matchingEditor, SIDE_GROUP);
			return;
		}

		const resource = BrowserViewUri.forId(generateUuid());
		const editorPane = await this._editorService.openEditor({ resource, options: { viewState: { url } } }, SIDE_GROUP);
		if (editorPane?.group) {
			editorPane.group.lock(true);
		}
	}
}
