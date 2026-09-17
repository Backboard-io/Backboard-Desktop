/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as dom from '../../../../../../../base/browser/dom.js';
import { DeferredPromise, timeout } from '../../../../../../../base/common/async.js';
import { toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { BackboardModelPicker } from '../../../../browser/widget/input/backboardModelPicker.js';

suite('BackboardModelPicker', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const seed = { values: ['off', 'one', 'two'], labels: ['Off', 'Model One', 'Model Two'], descriptions: [undefined, undefined, undefined], current: 'one' };

	function create(live: Promise<typeof seed>, refresh: () => Promise<typeof seed> = async () => seed) {
		const root = dom.append(document.body, dom.$('.backboard-composer-flow'));
		store.add(toDisposable(() => root.remove()));
		const heading = dom.append(root, dom.$('.backboard-composer-flow-header'));
		dom.append(heading, dom.$('strong', undefined, 'Video'));
		dom.append(heading, dom.$('button', undefined, 'Close'));
		const body = dom.append(root, dom.$('.backboard-composer-flow-body'));
		const selections: string[] = [];
		const picker = store.add(new BackboardModelPicker(body, {
			label: 'Video', getEnumInfo: () => seed, getCurrentValue: () => 'one',
			getDynamicEnumInfo: force => { assert.strictEqual(force, true); return refresh(); },
			setValue: value => selections.push(value),
		}, live));
		return {
			root, picker, selections,
			search: root.querySelector('input')!,
			button: heading.querySelector('button')!,
			status: root.querySelector('[role=status]')!,
		};
	}

	test('renders cached rows immediately with a single refresh button and a nested icon', async () => {
		const live = new DeferredPromise<typeof seed>();
		const { root, button } = create(live.p);
		assert.deepStrictEqual({
			rows: root.querySelectorAll('[role=option]').length,
			actions: root.querySelectorAll('.backboard-composer-flow-header button').length,
			buttonIsIcon: button.classList.contains('codicon'),
			spinner: !!button.querySelector('.codicon-loading.codicon-modifier-spin'),
			disabled: button.disabled,
		}, { rows: 3, actions: 1, buttonIsIcon: false, spinner: true, disabled: true });
		await live.complete(seed);
		await timeout(0);
		assert.ok(button.querySelector('.codicon-refresh'));
		assert.strictEqual(button.disabled, false);
	});

	test('refresh preserves filter, focus, and a selection made while loading', async () => {
		const next = new DeferredPromise<typeof seed>();
		const { root, button, search, selections } = create(Promise.resolve(seed), () => next.p);
		await timeout(0);
		search.value = 'Two';
		search.dispatchEvent(new Event('input'));
		button.click();
		root.querySelector<HTMLButtonElement>('[data-value=two]')!.click();
		await next.complete(seed);
		await timeout(0);
		assert.deepStrictEqual({
			filter: search.value,
			focused: document.activeElement === search,
			selected: root.querySelector('[aria-selected=true]')?.getAttribute('data-value'),
			selections,
		}, { filter: 'Two', focused: true, selected: 'two', selections: ['two'] });
	});

	test('failed refresh retains rows and exposes a retry without losing the filter', async () => {
		let calls = 0;
		const { root, button, status, search } = create(Promise.resolve(seed), async () => {
			if (++calls === 1) { throw new Error('offline'); }
			return seed;
		});
		await timeout(0);
		search.value = 'Model';
		search.dispatchEvent(new Event('input'));
		button.click();
		await timeout(0);
		assert.deepStrictEqual({ rows: root.querySelectorAll('[role=option]').length, disabled: button.disabled, filter: search.value }, { rows: 2, disabled: false, filter: 'Model' });
		assert.match(status.textContent!, /Try Refresh again/);
		button.click();
		await timeout(0);
		assert.strictEqual(status.textContent, '');
	});

	test('does not lose the no-matches message when a request completes', async () => {
		const live = new DeferredPromise<typeof seed>();
		const { search, status } = create(live.p);
		search.value = 'absent';
		search.dispatchEvent(new Event('input'));
		await live.complete(seed);
		await timeout(0);
		assert.match(status.textContent!, /No models match/);
	});

	test('ignores completion after dismissal', async () => {
		const live = new DeferredPromise<typeof seed>();
		const { root, picker } = create(live.p);
		picker.dispose();
		root.remove();
		const before = root.innerHTML;
		await live.complete({ ...seed, values: ['new'], labels: ['New'] });
		await timeout(0);
		assert.strictEqual(root.innerHTML, before);
	});
});
