/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import product from '../../../../../platform/product/common/product.js';
import { IURLHandler, IURLService } from '../../../../../platform/url/common/url.js';
import { attributionFromQuery, BackboardAnalyticsProps, IBackboardAnalyticsService } from '../../../../services/backboardAnalytics/common/backboardAnalytics.js';
import { BackboardAttributionContribution, LINK_ATTRIBUTION_COMMAND } from '../../electron-browser/backboardAttribution.contribution.js';

suite('Backboard campaign handoff', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('denied consent strips click IDs and untrusted identity fields', () => {
		assert.deepStrictEqual(attributionFromQuery('utm_source=meta&fbclid=click&user_id=other'), { marketing_consent: 'denied' });
		const result = attributionFromQuery(`marketing_consent=granted&utm_source=meta&utm_campaign=42&first_utm_source=tiktok&gclid=${'a'.repeat(700)}&user_id=other&access_token=secret`);
		assert.strictEqual(result.utm_campaign, '42');
		assert.strictEqual(result.first_utm_source, 'tiktok');
		assert.strictEqual(String(result.gclid).length, 500);
		assert.strictEqual(result.user_id, undefined);
		assert.strictEqual(result.access_token, undefined);
	});

	test('accepts exactly one matching browser callback, without passing credentials', async () => {
		const previous = product.backboardAnalytics;
		const previousProtocol = product.urlProtocol;
		Object.assign(product, { urlProtocol: 'backboard', backboardAnalytics: { ...previous, attributionUrl: 'https://bbstudio.com/redirect' } });
		disposables.add(toDisposable(() => Object.assign(product, { urlProtocol: previousProtocol, backboardAnalytics: previous })));
		let handler: IURLHandler;
		const urls = new class extends mock<IURLService>() { override registerHandler(value: IURLHandler) { handler = value; return toDisposable(() => {}); } };
		const opened: URI[] = [];
		const opener = new class extends mock<IOpenerService>() { override async open(uri: URI) { opened.push(uri); return true; } };
		const captured: BackboardAnalyticsProps[] = [];
		const analytics = new class extends mock<IBackboardAnalyticsService>() { override readonly enabled = true; override recordAttribution(props: BackboardAnalyticsProps) { captured.push(props); } };
		disposables.add(new BackboardAttributionContribution(urls, opener, analytics));
		const pending = CommandsRegistry.getCommand(LINK_ATTRIBUTION_COMMAND)!.handler(undefined!);
		const state = new URLSearchParams(opened[0].query).get('state');
		await handler!.handleURL(URI.parse('backboard://attribution/return?state=wrong&marketing_consent=granted&utm_source=meta'));
		assert.strictEqual(captured.length, 0);
		const uri = URI.parse(`backboard://attribution/return?state=${state}&marketing_consent=granted&utm_source=meta&campaign_id=42&access_token=secret`);
		await handler!.handleURL(uri);
		assert.strictEqual(await pending, true);
		await handler!.handleURL(uri);
		assert.deepStrictEqual(captured, [{ marketing_consent: 'granted', utm_source: 'meta', campaign_id: '42' }]);
		assert.strictEqual(opened[0].authority, 'bbstudio.com');
		assert.strictEqual(new URLSearchParams(opened[0].query).has('access_token'), false);
	});
});
