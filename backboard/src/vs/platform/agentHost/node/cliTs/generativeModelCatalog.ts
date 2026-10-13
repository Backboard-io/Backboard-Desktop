/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../log/common/log.js';

export type GenerativeModelProperty = 'imageModel' | 'videoModel';

export interface GenerativeModelItem {
	readonly value: string;
	readonly label: string;
	/** Picker secondary text; video models carry their capabilities (see generativeMediaCapabilities.ts). */
	readonly description?: string;
}

interface CatalogEntry {
	readonly items: readonly GenerativeModelItem[];
	readonly fetchedAt: number;
}

const properties: readonly GenerativeModelProperty[] = ['imageModel', 'videoModel'];
const freshnessInterval = 10 * 60 * 1000;

/** Last successful media catalogs, scoped to the backend and hydrated before config resolution. */
export class GenerativeModelCatalog extends Disposable {
	private apiUrl: string | undefined;
	private generation = 0;
	private readonly entries = new Map<GenerativeModelProperty, CatalogEntry>();
	private readonly pending = new Map<GenerativeModelProperty, Promise<readonly GenerativeModelItem[]>>();

	constructor(
		private readonly cachePath: string,
		private readonly getApiUrl: () => string,
		private readonly fetchCatalog: (property: GenerativeModelProperty) => Promise<readonly GenerativeModelItem[]>,
		private readonly logService: ILogService,
		private readonly now: () => number = Date.now,
	) {
		super();
		this.ensureScope();
	}

	/** Returns even stale entries so rendering never waits for a network refresh. */
	peek(property: GenerativeModelProperty): readonly GenerativeModelItem[] | undefined {
		this.ensureScope();
		return this.entries.get(property)?.items;
	}

	/** Refreshes expired entries; callers can display peek() while this promise is pending. */
	get(property: GenerativeModelProperty, refresh = false): Promise<readonly GenerativeModelItem[]> {
		this.ensureScope();
		const entry = this.entries.get(property);
		if (!refresh && entry && this.now() - entry.fetchedAt < freshnessInterval) {
			return Promise.resolve(entry.items);
		}
		const pending = this.pending.get(property);
		if (pending) {
			return pending;
		}
		const generation = this.generation;
		const request = this.fetchCatalog(property).then(items => {
			this.ensureScope();
			if (generation !== this.generation || this._store.isDisposed) {
				throw new Error('Model catalog request is no longer current.');
			}
			this.entries.set(property, { items, fetchedAt: this.now() });
			this.persist();
			return items;
		}).finally(() => {
			if (this.pending.get(property) === request) {
				this.pending.delete(property);
			}
		});
		this.pending.set(property, request);
		return request;
	}

	private ensureScope(): void {
		const apiUrl = this.getApiUrl();
		if (this.apiUrl === apiUrl) {
			return;
		}
		this.apiUrl = apiUrl;
		this.generation++;
		this.entries.clear();
		this.pending.clear();
		try {
			const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
			if (data?.version !== 1 || data.apiUrl !== apiUrl) {
				return;
			}
			for (const property of properties) {
				const entry = data.catalogs?.[property];
				if (entry && typeof entry.fetchedAt === 'number' && Number.isFinite(entry.fetchedAt)
					&& entry.fetchedAt >= 0 && entry.fetchedAt <= this.now() && Array.isArray(entry.items)
					&& entry.items.every((item: GenerativeModelItem | null) => item && typeof item.value === 'string'
						&& item.value.length > 0 && typeof item.label === 'string' && item.label.length > 0)) {
					this.entries.set(property, { fetchedAt: entry.fetchedAt, items: entry.items.map((item: GenerativeModelItem) => ({ value: item.value, label: item.label, ...(typeof item.description === 'string' ? { description: item.description } : {}) })) });
				}
			}
		} catch {
			// Missing or corrupt cache: the first successful fetch will replace it.
		}
	}

	private persist(): void {
		const temporaryPath = `${this.cachePath}.${generateUuid()}.tmp`;
		try {
			fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
			fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, apiUrl: this.apiUrl, catalogs: Object.fromEntries(this.entries) }), 'utf8');
			fs.renameSync(temporaryPath, this.cachePath);
		} catch (error) {
			this.logService.info(`[cli-ts] Could not persist media model cache: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			try { fs.rmSync(temporaryPath, { force: true }); } catch { /* Best-effort temporary file cleanup. */ }
		}
	}
}
