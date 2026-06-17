/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService, IFileStatWithMetadata } from '../../../../platform/files/common/files.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isIChatSessionFileChange2 } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ISession, ISessionFileChange } from '../../../services/sessions/common/session.js';
import { ISandboxWorkspaceChange, ISandboxWorkspaceChangeDetails, ISandboxWorkspaceChangesService, SandboxWorkspaceChangeType } from '../common/sandboxChanges.js';

interface ISandboxWorkspaceFileSnapshot {
	readonly resource: URI;
	readonly content: string | undefined;
	readonly mtime: number;
	readonly ctime: number;
	readonly size: number;
}

interface ISandboxWorkspaceBaseline {
	readonly files: Map<string, ISandboxWorkspaceFileSnapshot>;
}

export class SandboxWorkspaceChangesService extends Disposable implements ISandboxWorkspaceChangesService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _baselines = new Map<string, Promise<ISandboxWorkspaceBaseline>>();

	constructor(
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();

		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this.reset(undefined);
			void this.ensureBaseline(undefined);
		}));

		this._register(this._fileService.onDidFilesChange(() => this._onDidChange.fire()));
	}

	async ensureBaseline(session: ISession | undefined): Promise<void> {
		const roots = this._getSandboxWorkspaceRoots(session);
		if (!roots.length) {
			return;
		}

		const workspaceKey = this._workspaceBaselineKey(session, roots);
		if (!this._baselines.has(workspaceKey)) {
			this._baselines.set(workspaceKey, this._createWorkspaceBaseline(roots));
		}

		await this._baselines.get(workspaceKey);
	}

	async getChanges(session: ISession | undefined): Promise<readonly ISandboxWorkspaceChange[]> {
		const roots = this._getSandboxWorkspaceRoots(session);
		if (!roots.length) {
			return [];
		}

		const workspaceKey = this._workspaceBaselineKey(session, roots);
		const protocolChanges = this._collectSessionChanges(session, roots);
		const baselinePromise = this._baselines.get(workspaceKey);
		const currentFiles = await this._collectWorkspaceFileSnapshots(roots);

		const changesByUri = new Map<string, ISandboxWorkspaceChange>();
		for (const change of protocolChanges) {
			changesByUri.set(change.uri.toString(), change);
		}

		if (baselinePromise) {
			const baseline = await baselinePromise;
			const seen = new Set<string>();
			for (const [key, current] of currentFiles) {
				seen.add(key);
				const before = baseline.files.get(key);
				if (!before) {
					this._setIfMissing(changesByUri, current.resource, 'added');
					continue;
				}

				const contentChanged = before.content !== undefined && current.content !== undefined
					? before.content !== current.content
					: before.mtime !== current.mtime || before.size !== current.size;
				if (contentChanged) {
					this._setIfMissing(changesByUri, current.resource, 'modified');
				}
			}

			for (const [key, before] of baseline.files) {
				if (!seen.has(key)) {
					this._setIfMissing(changesByUri, before.resource, 'deleted');
				}
			}
		} else {
			void this.ensureBaseline(session);
		}

		this._collectSessionAgeChanges(session, currentFiles, changesByUri);

		return [...changesByUri.values()].sort((a, b) => a.uri.toString().localeCompare(b.uri.toString()));
	}

	async getChangeDetails(session: ISession | undefined, uri: URI): Promise<ISandboxWorkspaceChangeDetails | undefined> {
		const roots = this._getSandboxWorkspaceRoots(session);
		if (!roots.length || !this._isInRoots(uri, roots)) {
			return undefined;
		}

		const changes = await this.getChanges(session);
		const change = changes.find(change => extUri.isEqual(change.uri, uri));
		if (!change) {
			return undefined;
		}

		const workspaceKey = this._workspaceBaselineKey(session, roots);
		const baseline = await this._baselines.get(workspaceKey);
		const beforeSnapshot = baseline?.files.get(uri.toString());
		const sessionChange = this._findSessionFileChange(session, uri);

		let beforeContent = beforeSnapshot?.content;
		if (beforeContent === undefined && sessionChange?.originalUri) {
			beforeContent = await this._readFileContent(sessionChange.originalUri);
		}

		let afterContent = change.type === 'deleted' ? undefined : await this._readFileContent(uri);
		if (afterContent === undefined && sessionChange && this._sessionChangeModifiedUri(sessionChange)) {
			afterContent = await this._readFileContent(this._sessionChangeModifiedUri(sessionChange)!);
		}

		if (change.type === 'added' && beforeContent === undefined) {
			beforeContent = '';
		}
		if (change.type === 'deleted' && afterContent === undefined) {
			afterContent = '';
		}

		return {
			change,
			beforeContent,
			afterContent,
			hasBeforeContent: beforeContent !== undefined,
			hasAfterContent: afterContent !== undefined,
		};
	}

	reset(_session: ISession | undefined): void {
		this._baselines.clear();
		this._onDidChange.fire();
	}

	signalChanged(): void {
		this._onDidChange.fire();
	}

	private _collectSessionAgeChanges(session: ISession | undefined, currentFiles: ReadonlyMap<string, ISandboxWorkspaceFileSnapshot>, changesByUri: Map<string, ISandboxWorkspaceChange>): void {
		if (!session) {
			return;
		}

		const changedAfter = session.createdAt.getTime() - 1000;
		for (const current of currentFiles.values()) {
			if (current.mtime >= changedAfter || current.ctime >= changedAfter) {
				this._setIfMissing(changesByUri, current.resource, 'modified');
			}
		}
	}

	private _collectSessionChanges(session: ISession | undefined, roots: readonly URI[]): ISandboxWorkspaceChange[] {
		if (!session) {
			return [];
		}

		const changes: ISandboxWorkspaceChange[] = [];
		const seen = new Set<string>();
		for (const change of session.changes.get()) {
			const uri = this._sessionChangeUri(change);
			if (!uri || !this._isInRoots(uri, roots)) {
				continue;
			}

			const key = uri.toString();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			changes.push({ uri, type: this._sessionChangeType(change) });
		}
		return changes;
	}

	private _sessionChangeUri(change: ISessionFileChange): URI | undefined {
		if (isIChatSessionFileChange2(change)) {
			return change.modifiedUri ?? change.uri ?? change.originalUri;
		}
		return change.modifiedUri ?? change.originalUri;
	}

	private _sessionChangeModifiedUri(change: ISessionFileChange): URI | undefined {
		if (isIChatSessionFileChange2(change)) {
			return change.modifiedUri ?? change.uri;
		}
		return change.modifiedUri;
	}

	private _sessionChangeType(change: ISessionFileChange): SandboxWorkspaceChangeType {
		if (isIChatSessionFileChange2(change) && !change.modifiedUri && change.originalUri) {
			return 'deleted';
		}
		return 'modified';
	}

	private _setIfMissing(changesByUri: Map<string, ISandboxWorkspaceChange>, uri: URI, type: SandboxWorkspaceChangeType): void {
		const key = uri.toString();
		if (!changesByUri.has(key)) {
			changesByUri.set(key, { uri, type });
		}
	}

	private async _createWorkspaceBaseline(roots: readonly URI[]): Promise<ISandboxWorkspaceBaseline> {
		return {
			files: await this._collectWorkspaceFileSnapshots(roots),
		};
	}

	private async _collectWorkspaceFileSnapshots(roots: readonly URI[]): Promise<Map<string, ISandboxWorkspaceFileSnapshot>> {
		const files = new Map<string, ISandboxWorkspaceFileSnapshot>();
		for (const root of roots) {
			await this._collectWorkspaceFileSnapshotsFrom(root, files);
		}
		return files;
	}

	private async _collectWorkspaceFileSnapshotsFrom(resource: URI, files: Map<string, ISandboxWorkspaceFileSnapshot>): Promise<void> {
		if (files.size > 1000 || this._shouldHideResource(resource)) {
			return;
		}

		let stat: IFileStatWithMetadata;
		try {
			stat = await this._fileService.resolve(resource, { resolveMetadata: true });
		} catch {
			return;
		}

		if (stat.isDirectory) {
			for (const child of stat.children ?? []) {
				await this._collectWorkspaceFileSnapshotsFrom(child.resource, files);
				if (files.size > 1000) {
					return;
				}
			}
			return;
		}

		const size = stat.size;
		const content = size <= 1024 * 1024 ? await this._readFileContent(stat.resource) : undefined;

		files.set(stat.resource.toString(), {
			resource: stat.resource,
			content,
			mtime: stat.mtime,
			ctime: stat.ctime,
			size,
		});
	}

	private async _readFileContent(resource: URI): Promise<string | undefined> {
		try {
			return (await this._fileService.readFile(resource)).value.toString();
		} catch {
			return undefined;
		}
	}

	private _findSessionFileChange(session: ISession | undefined, resource: URI): ISessionFileChange | undefined {
		const changes = session?.changes.get();
		if (!changes) {
			return undefined;
		}

		return changes.find(change => {
			const uri = this._sessionChangeUri(change);
			if (uri && extUri.isEqual(uri, resource)) {
				return true;
			}
			if (change.originalUri && extUri.isEqual(change.originalUri, resource)) {
				return true;
			}
			return this._sessionChangeModifiedUri(change) ? extUri.isEqual(this._sessionChangeModifiedUri(change)!, resource) : false;
		});
	}

	private _getSandboxWorkspaceRoots(session: ISession | undefined): URI[] {
		const sessionFolders = session?.workspace.get()?.folders;
		if (sessionFolders?.length) {
			return this._dedupeUris(sessionFolders.map(folder => folder.workingDirectory));
		}
		return this._workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
	}

	private _workspaceBaselineKey(session: ISession | undefined, roots: readonly URI[]): string {
		const sessionKey = session ? `${session.sessionId}\n${session.resource.toString()}` : 'workspace';
		const rootsKey = roots.map(root => root.toString()).sort().join('\n');
		return `${sessionKey}\n${rootsKey}`;
	}

	private _dedupeUris(resources: readonly URI[]): URI[] {
		const result: URI[] = [];
		for (const resource of resources) {
			if (!result.some(existing => extUri.isEqual(existing, resource))) {
				result.push(resource);
			}
		}
		return result;
	}

	private _isInRoots(resource: URI, roots: readonly URI[]): boolean {
		return roots.some(root => extUri.isEqual(resource, root) || extUri.isEqualOrParent(resource, root));
	}

	private _shouldHideResource(resource: URI): boolean {
		switch (basename(resource) || resource.authority || resource.toString()) {
			case '.git':
			case 'node_modules':
			case '.next':
			case 'out':
			case 'dist':
				return true;
			default:
				return false;
		}
	}
}

registerSingleton(ISandboxWorkspaceChangesService, SandboxWorkspaceChangesService, InstantiationType.Delayed);
