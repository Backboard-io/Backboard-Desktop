/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BackboardSignIns, type BackboardSignInSteps } from '../signInCore';
import type { BackboardDeviceCodeResponse, BackboardOAuthTokens } from '../types';

const device: BackboardDeviceCodeResponse = {
	device_code: 'device-1',
	user_code: 'WXYZ-1234',
	verification_uri: 'https://app.backboard.io/device',
	verification_uri_complete: 'https://app.backboard.io/device?user_code=WXYZ-1234',
	expires_in: 900,
	interval: 5,
};

const tokens: BackboardOAuthTokens = { access_token: 'test-access-token' };

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

/** Steps that record what ran; `overrides` replaces any of them. */
function steps(overrides: Partial<BackboardSignInSteps> = {}) {
	const calls: string[] = [];
	const result: BackboardSignInSteps = {
		requestDeviceCode: async () => { calls.push('requestDeviceCode'); return device; },
		openBrowser: async url => { calls.push(`openBrowser ${url}`); },
		pollForTokens: async () => { calls.push('pollForTokens'); return tokens; },
		save: async saved => { calls.push(`save ${saved.access_token}`); },
		...overrides,
	};
	return { calls, steps: result };
}

describe('Backboard sign-in', () => {
	test('signs in and hands out the link only while waiting for approval', async () => {
		const signIns = new BackboardSignIns();
		const approval = deferred<BackboardOAuthTokens>();
		const polled = deferred<void>();
		const run = steps({ pollForTokens: () => { polled.resolve(); return approval.promise; } });
		const outcome = signIns.run(run.steps);
		const beforeDeviceCode = signIns.link();
		await polled.promise;
		const whileWaiting = signIns.link();
		approval.resolve(tokens);
		assert.deepStrictEqual({ beforeDeviceCode, whileWaiting, outcome: await outcome, after: signIns.link(), calls: run.calls }, {
			beforeDeviceCode: undefined,
			whileWaiting: { url: device.verification_uri_complete, userCode: 'WXYZ-1234' },
			outcome: { status: 'signedIn' },
			after: undefined,
			calls: ['requestDeviceCode', `openBrowser ${device.verification_uri_complete}`, 'save test-access-token'],
		});
	});

	test('reports a failure instead of throwing, whichever step fails', async () => {
		const failures: Partial<BackboardSignInSteps>[] = [
			{ requestDeviceCode: async () => { throw new Error('Backboard device-code request failed: HTTP 503'); } },
			{ openBrowser: async () => { throw new Error('Could not open the sign-in page in your browser. Please try again.'); } },
			{ pollForTokens: async () => { throw new Error('Backboard device login was denied.'); } },
			{ save: async () => { throw new Error('EACCES: permission denied'); } },
		];
		const signIns = new BackboardSignIns();
		const outcomes = [];
		for (const failure of failures) {
			outcomes.push(await signIns.run(steps(failure).steps));
		}
		assert.deepStrictEqual({ outcomes, nothingLeftToCancel: !signIns.cancel() }, {
			outcomes: [
				{ status: 'failed', error: 'Backboard device-code request failed: HTTP 503' },
				{ status: 'failed', error: 'Could not open the sign-in page in your browser. Please try again.' },
				{ status: 'failed', error: 'Backboard device login was denied.' },
				{ status: 'failed', error: 'EACCES: permission denied' },
			],
			nothingLeftToCancel: true,
		});
	});

	test('cancels at once while the device-code request is still out, and goes no further', async () => {
		const signIns = new BackboardSignIns();
		const request = deferred<BackboardDeviceCodeResponse>();
		const run = steps({ requestDeviceCode: () => request.promise });
		const outcome = signIns.run(run.steps);
		const cancelled = signIns.cancel();
		const result = await outcome;
		request.resolve(device);
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual({ cancelled, result, calls: run.calls }, { cancelled: true, result: { status: 'cancelled' }, calls: [] });
	});

	test('cancelling while waiting for approval stops the polling and saves nothing', async () => {
		const signIns = new BackboardSignIns();
		const polled = deferred<() => boolean>();
		const approval = deferred<BackboardOAuthTokens>();
		const run = steps({ pollForTokens: (_device, isCancelled) => { polled.resolve(isCancelled); return approval.promise; } });
		const outcome = signIns.run(run.steps);
		const isCancelled = await polled.promise;
		const beforeCancel = isCancelled();
		signIns.cancel();
		const result = await outcome;
		// The poll loop notices on its next turn and gives up.
		approval.reject(new Error('Backboard device login was cancelled.'));
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual({ beforeCancel, afterCancel: isCancelled(), result, link: signIns.link(), calls: run.calls }, {
			beforeCancel: false,
			afterCancel: true,
			result: { status: 'cancelled' },
			link: undefined,
			calls: ['requestDeviceCode', `openBrowser ${device.verification_uri_complete}`],
		});
	});

	test('a second sign-in replaces one still waiting', async () => {
		const signIns = new BackboardSignIns();
		const firstApproval = deferred<BackboardOAuthTokens>();
		const first = signIns.run(steps({ pollForTokens: () => firstApproval.promise }).steps);
		const second = signIns.run(steps().steps);
		assert.deepStrictEqual([await first, await second], [{ status: 'cancelled' }, { status: 'signedIn' }]);
	});
});
