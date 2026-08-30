/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { Schemas } from '../../base/common/network.js';
import { URI } from '../../base/common/uri.js';
import { IFileService } from '../../platform/files/common/files.js';

/**
 * Tracks which local folders (from a caller-supplied set of folder URIs) no
 * longer exist on disk, so UI surfaces in the sessions window can hide folders
 * the user has deleted.
 *
 * Only `file://` folders backed by a registered file system provider are ever
 * reported as missing. Folders on schemes we cannot stat locally (remote,
 * agent host, virtual) are always treated as present. Any error while checking
 * is treated as "present" so a transient failure never hides a folder.
 *
 * Existence is checked asynchronously and cached; {@link isMissing} answers
 * synchronously from the cache. Call {@link refresh} to re-check (for example
 * on window focus or when the recent-folder list changes); {@link onDidChange}
 * fires when the missing set changes so consumers can re-render.
 */
export class MissingFolderTracker extends Disposable {

	private readonly _missing = new Set<string>();

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
	) {
		super();
	}

	/**
	 * Whether the given folder is known (as of the last {@link refresh}) to have
	 * been deleted from disk. Always `false` for non-local folders and for
	 * folders that have not been checked yet.
	 */
	isMissing(folder: URI | undefined): boolean {
		return !!folder && this._missing.has(folder.toString());
	}

	/**
	 * Re-check existence of the given folders and update the cache. Folders not
	 * present in `folders` are dropped from the cache, so a previously-deleted
	 * folder that is recreated (or no longer relevant) stops being reported as
	 * missing. Fires {@link onDidChange} only when the missing set changes.
	 */
	async refresh(folders: readonly URI[]): Promise<void> {
		const checked = new Set<string>();
		const next = new Set<string>();

		await Promise.all(folders.map(async folder => {
			const key = folder.toString();
			if (checked.has(key)) {
				return;
			}
			checked.add(key);

			// Only local folders backed by a provider can be meaningfully
			// checked; everything else is assumed present.
			if (folder.scheme !== Schemas.file || !this.fileService.hasProvider(folder)) {
				return;
			}

			try {
				if (!await this.fileService.exists(folder)) {
					next.add(key);
				}
			} catch {
				// Never hide a folder because of a stat failure.
			}
		}));

		if (!this._areSetsEqual(this._missing, next)) {
			this._missing.clear();
			for (const key of next) {
				this._missing.add(key);
			}
			this._onDidChange.fire();
		}
	}

	private _areSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
		if (a.size !== b.size) {
			return false;
		}
		for (const value of a) {
			if (!b.has(value)) {
				return false;
			}
		}
		return true;
	}
}
