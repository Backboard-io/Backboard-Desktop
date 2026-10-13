/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { bufferToStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/index.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import product from '../../../../../platform/product/common/product.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ILifecycleService } from '../../../lifecycle/common/lifecycle.js';
import { IWorkbenchEnvironmentService } from '../../../environment/common/environmentService.js';
import { BackboardAnalyticsService } from '../../browser/backboardAnalyticsService.js';

suite('Backboard PostHog event delivery', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	function setup(statuses = [200]) {
		const previous = product.backboardAnalytics;
		Object.assign(product, { backboardAnalytics: { posthogKey: 'test-project-key', posthogHost: 'https://example.invalid' } });
		disposables.add(toDisposable(() => Object.assign(product, { backboardAnalytics: previous })));
		const sent: { batch: { event: string; distinct_id: string; properties: Record<string, unknown> }[] }[] = [];
		const config = new TestConfigurationService({ telemetry: { telemetryLevel: 'all' } });
		const request = new class extends mock<IRequestService>() {
			override async request(options: { data?: string }) {
				sent.push(JSON.parse(options.data!));
				return { res: { statusCode: statuses[Math.min(sent.length - 1, statuses.length - 1)], headers: {} }, stream: bufferToStream(VSBuffer.fromString('{}')) };
			}
		};
		const lifecycle = new class extends mock<ILifecycleService>() { override readonly onWillShutdown = Event.None; };
		const environment = new class extends mock<IWorkbenchEnvironmentService>() { override readonly isBuilt = false; };
		const analytics = disposables.add(new BackboardAnalyticsService(config, disposables.add(new InMemoryStorageService()), request, new NullLogService(), lifecycle, environment));
		return { analytics, sent, config };
	}

	test('campaign metadata follows the identified user and disappears on logout', async () => {
		const { analytics, sent } = setup();
		analytics.recordAttribution({ marketing_consent: 'granted', utm_source: 'meta', utm_campaign: '42', first_utm_source: 'tiktok', access_token: 'secret' });
		analytics.identify('account-1');
		for (let i = 0; i < 48; i++) { analytics.capture('app_opened'); }
		await Promise.resolve();
		assert.strictEqual(sent.length, 1);
		const identified = sent[0].batch[1];
		assert.strictEqual(identified.distinct_id, 'account-1');
		assert.strictEqual((identified.properties.$set_once as Record<string, unknown>).$initial_utm_source, 'tiktok');
		assert.strictEqual(sent[0].batch[2].properties.utm_campaign, '42');
		assert.strictEqual(sent[0].batch[2].properties.access_token, undefined);
		assert.ok(sent[0].batch.every(event => event.properties.$insert_id));
		analytics.reset();
		for (let i = 0; i < 50; i++) { analytics.capture('app_opened'); }
		assert.notStrictEqual(sent[1].batch[0].distinct_id, 'account-1');
		assert.strictEqual(sent[1].batch[0].properties.utm_source, undefined);
		assert.strictEqual(sent[1].batch[0].properties.marketing_consent, 'denied');
	});

	test('transient ingestion failures retry with the same deduplication IDs', async () => {
		await runWithFakedTimers({ useFakeTimers: true }, async () => {
			const { analytics, sent } = setup([503, 200]);
			for (let i = 0; i < 50; i++) { analytics.capture('app_opened'); }
			await timeout(10001);
			assert.strictEqual(sent.length, 2);
			assert.deepStrictEqual(sent[1].batch, sent[0].batch);
		});
	});
});
