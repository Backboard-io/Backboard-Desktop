/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeferredPromise } from '../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { GenerativeModelCatalog, type GenerativeModelItem, type GenerativeModelProperty } from '../../node/cliTs/generativeModelCatalog.js';

suite('GenerativeModelCatalog', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const image = [{ value: 'google/image', label: 'Image' }];
	const video = [{ value: 'bytedance/video', label: 'Video' }];
	let directory: string;
	let cachePath: string;
	let now: number;
	let apiUrl: string;

	setup(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-media-models-'));
		cachePath = path.join(directory, 'models.json');
		now = 1_000_000;
		apiUrl = 'https://backend.example';
	});

	teardown(() => fs.rmSync(directory, { recursive: true, force: true }));

	function create(fetchCatalog: (property: GenerativeModelProperty) => Promise<readonly GenerativeModelItem[]>): GenerativeModelCatalog {
		return store.add(new GenerativeModelCatalog(cachePath, () => apiUrl, fetchCatalog, new NullLogService(), () => now));
	}

	test('hydrates both catalogs after restart and reuses fresh results without fetching', async () => {
		const first = create(async property => property === 'imageModel' ? image : video);
		await Promise.all([first.get('imageModel'), first.get('videoModel')]);
		first.dispose();
		let calls = 0;
		const restarted = create(async () => { calls++; return []; });
		assert.deepStrictEqual({
			image: restarted.peek('imageModel'),
			video: await restarted.get('videoModel'),
			calls,
		}, { image, video, calls: 0 });
	});

	test('keeps stale entries available while fetching and persists the replacement', async () => {
		const next = new DeferredPromise<readonly GenerativeModelItem[]>();
		let calls = 0;
		const cache = create(async () => ++calls === 1 ? image : next.p);
		await cache.get('imageModel');
		now += 10 * 60 * 1000;
		const refresh = cache.get('imageModel');
		assert.deepStrictEqual(cache.peek('imageModel'), image);
		await next.complete(video);
		assert.deepStrictEqual(await refresh, video);
		assert.deepStrictEqual(create(async () => []).peek('imageModel'), video);
	});

	test('explicit refresh bypasses fresh data and joins an active fetch for that property', async () => {
		const next = new DeferredPromise<readonly GenerativeModelItem[]>();
		let calls = 0;
		const cache = create(async () => ++calls === 1 ? image : next.p);
		await cache.get('imageModel');
		const first = cache.get('imageModel', true);
		const second = cache.get('imageModel', true);
		assert.strictEqual(first, second);
		await next.complete(video);
		assert.deepStrictEqual({ items: await second, calls }, { items: video, calls: 2 });
	});

	test('image and video requests complete independently', async () => {
		const images = new DeferredPromise<readonly GenerativeModelItem[]>();
		const videos = new DeferredPromise<readonly GenerativeModelItem[]>();
		const cache = create(property => property === 'imageModel' ? images.p : videos.p);
		const first = cache.get('imageModel');
		const second = cache.get('videoModel');
		await videos.complete(video);
		assert.deepStrictEqual(await second, video);
		await images.complete(image);
		assert.deepStrictEqual(await first, image);
	});

	test('failed refresh preserves disk contents and freshness, and the next open retries', async () => {
		let calls = 0;
		const cache = create(async () => {
			if (++calls === 2) { throw new Error('timeout'); }
			return image;
		});
		await cache.get('imageModel');
		const before = fs.readFileSync(cachePath, 'utf8');
		now += 10 * 60 * 1000;
		await assert.rejects(cache.get('imageModel'), /timeout/);
		assert.deepStrictEqual({ items: cache.peek('imageModel'), disk: fs.readFileSync(cachePath, 'utf8') }, { items: image, disk: before });
		await cache.get('imageModel');
		assert.strictEqual(calls, 3);
	});

	test('first-fetch failure is not cached and can be retried', async () => {
		let calls = 0;
		const cache = create(async () => {
			if (++calls === 1) { throw new Error('offline'); }
			return image;
		});
		await assert.rejects(cache.get('imageModel'), /offline/);
		assert.strictEqual(fs.existsSync(cachePath), false);
		assert.deepStrictEqual(await cache.get('imageModel'), image);
	});

	test('accepts a successful empty catalog', async () => {
		const cache = create(async () => []);
		await cache.get('videoModel');
		assert.deepStrictEqual(create(async () => video).peek('videoModel'), []);
	});

	test('ignores corrupt, incompatible, malformed, and mismatched-API caches', () => {
		for (const data of [
			'{invalid',
			JSON.stringify({ version: 2, apiUrl, catalogs: { imageModel: { items: image, fetchedAt: now } } }),
			JSON.stringify({ version: 1, apiUrl: 'https://other.example', catalogs: { imageModel: { items: image, fetchedAt: now } } }),
			JSON.stringify({ version: 1, apiUrl, catalogs: { imageModel: { items: [{ value: 123 }], fetchedAt: now } } }),
			JSON.stringify({ version: 1, apiUrl, catalogs: { imageModel: { items: image, fetchedAt: 'yesterday' } } }),
		]) {
			fs.writeFileSync(cachePath, data);
			assert.strictEqual(create(async () => image).peek('imageModel'), undefined);
		}
	});

	test('backend switch discards old entries and refuses a response from the previous backend', async () => {
		const old = new DeferredPromise<readonly GenerativeModelItem[]>();
		let calls = 0;
		const cache = create(async () => ++calls === 1 ? old.p : video);
		const pending = cache.get('imageModel');
		apiUrl = 'https://other.example';
		assert.strictEqual(cache.peek('imageModel'), undefined);
		await cache.get('imageModel');
		await old.complete(image);
		await assert.rejects(pending, /no longer current/);
		assert.deepStrictEqual(create(async () => []).peek('imageModel'), video);
	});

	test('disposing during a request prevents late writes', async () => {
		const next = new DeferredPromise<readonly GenerativeModelItem[]>();
		const cache = create(() => next.p);
		const pending = cache.get('imageModel');
		cache.dispose();
		await next.complete(image);
		await assert.rejects(pending, /no longer current/);
		assert.strictEqual(fs.existsSync(cachePath), false);
	});
});
