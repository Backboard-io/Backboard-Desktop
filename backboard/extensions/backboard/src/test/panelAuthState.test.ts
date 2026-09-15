/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { PanelAuthState } from '../panel/authState';

test('an existing SSO login does not wait for a subscription probe', async () => {
	const state = new PanelAuthState();
	assert.equal(await state.refresh(() => true, () => assert.fail('must not probe subscriptions')), true);
});

test('a pre-login probe cannot restore the popup after sign-in', async () => {
	const state = new PanelAuthState();
	let finishProbe!: (value: boolean) => void;
	const stale = state.refresh(() => false, () => new Promise(resolve => { finishProbe = resolve; }));
	assert.equal(await state.refresh(() => true, async () => false), true);
	finishProbe(false);
	assert.equal(await stale, undefined);
});

test('credentials are read again if sign-in finishes while probing', async () => {
	const state = new PanelAuthState();
	let signedIn = false;
	assert.equal(await state.refresh(() => signedIn, async () => { signedIn = true; return false; }), true);
});

test('sign-out restores the popup after a successful credential check', async () => {
	const state = new PanelAuthState();
	assert.equal(await state.refresh(() => true, async () => false), true);
	assert.equal(await state.refresh(() => false, async () => false), false);
});

test('subscription probe errors preserve login, but confirmed removal clears it', async () => {
	const state = new PanelAuthState();
	assert.equal(await state.refresh(() => false, async () => true), true);
	assert.equal(await state.refresh(() => false, async () => { throw new Error('Unavailable'); }), true);
	assert.equal(await state.refresh(() => false, async () => false), false);
});
