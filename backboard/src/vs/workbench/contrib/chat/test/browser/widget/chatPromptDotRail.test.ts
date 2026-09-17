/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { activePromptIndex, ChatPromptDotRail, IChatPromptDot, promptWindowStart } from '../../../browser/widget/chatPromptDotRail.js';

suite('ChatPromptDotRail', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// Mirrors the rail's own constants: 15 visible dots of 12px each, with a 30px
	// fade zone at the top and the bottom of the viewport.
	const SPACING = 12;
	const VISIBLE_DOTS = 15;
	const WINDOW_HEIGHT = VISIBLE_DOTS * SPACING;

	function prompts(count: number): IChatPromptDot[] {
		return Array.from({ length: count }, (_, index) => ({ id: `prompt-${index}`, label: `Prompt ${index + 1}` }));
	}

	function createRail(): { rail: ChatPromptDotRail; container: HTMLElement } {
		const container = document.createElement('div');
		document.body.append(container);
		store.add({ dispose: () => container.remove() });
		const rail = store.add(new ChatPromptDotRail(container));
		return { rail, container };
	}

	function dots(container: HTMLElement): HTMLElement[] {
		return [...container.querySelectorAll<HTMLElement>('.chat-prompt-dot')];
	}

	function railElement(container: HTMLElement): HTMLElement {
		const element = container.querySelector<HTMLElement>('.chat-prompt-dot-rail');
		assert.ok(element, 'the rail must be mounted in its container');
		return element;
	}

	function trackOffset(container: HTMLElement): string | undefined {
		return container.querySelector<HTMLElement>('.chat-prompt-dot-track')?.style.transform;
	}

	function viewportHeight(container: HTMLElement): string | undefined {
		return container.querySelector<HTMLElement>('.chat-prompt-dot-viewport')?.style.height;
	}

	function visibleIndices(container: HTMLElement): number[] {
		return dots(container)
			.map((dot, index) => dot.style.visibility === 'hidden' ? -1 : index)
			.filter(index => index >= 0);
	}

	test('stays hidden until the transcript has more than one prompt', () => {
		const { rail, container } = createRail();

		rail.update(prompts(0), 0);
		assert.strictEqual(railElement(container).classList.contains('hidden'), true);
		assert.strictEqual(dots(container).length, 0);

		// A single prompt is the transcript itself; a one-dot rail adds nothing.
		rail.update(prompts(1), 0);
		assert.strictEqual(railElement(container).classList.contains('hidden'), true);

		rail.update(prompts(2), 1);
		assert.strictEqual(railElement(container).classList.contains('hidden'), false);
		assert.strictEqual(dots(container).length, 2);
	});

	test('renders one labelled dot per prompt and rebuilds when the count changes', () => {
		const { rail, container } = createRail();

		rail.update(prompts(3), 0);
		const first = dots(container);
		assert.strictEqual(first.length, 3);
		assert.deepStrictEqual(first.map(dot => dot.dataset.index), ['0', '1', '2']);
		assert.deepStrictEqual(first.map(dot => dot.getAttribute('role')), ['button', 'button', 'button']);
		assert.deepStrictEqual(first.map(dot => dot.getAttribute('aria-label')), [
			'Go to prompt 1: Prompt 1',
			'Go to prompt 2: Prompt 2',
			'Go to prompt 3: Prompt 3',
		]);
		assert.deepStrictEqual(first.map(dot => dot.title), ['Prompt 1', 'Prompt 2', 'Prompt 3']);
		// Dots are stacked by index, independent of the sliding window.
		assert.deepStrictEqual(first.map(dot => dot.style.top), ['0px', `${SPACING}px`, `${2 * SPACING}px`]);

		rail.update([{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }], 0);
		const rebuilt = dots(container);
		assert.strictEqual(rebuilt.length, 2);
		assert.deepStrictEqual(rebuilt.map(dot => dot.getAttribute('aria-label')), [
			'Go to prompt 1: Alpha',
			'Go to prompt 2: Beta',
		]);
	});

	test('shows a window of 15 dots and clamps it at both ends', () => {
		const { rail, container } = createRail();

		// Fewer prompts than the window: the viewport shrinks to fit them.
		rail.update(prompts(3), 0);
		assert.strictEqual(viewportHeight(container), `${3 * SPACING}px`);
		assert.strictEqual(trackOffset(container), 'translateY(0px)');

		rail.update(prompts(30), 0);
		assert.strictEqual(viewportHeight(container), `${WINDOW_HEIGHT}px`);
		assert.strictEqual(trackOffset(container), 'translateY(0px)');
		assert.deepStrictEqual(visibleIndices(container), Array.from({ length: VISIBLE_DOTS }, (_, index) => index));

		// The active dot is centred once the window can move, so prompt 15 (index
		// 14) sits seven dots into the window.
		rail.update(prompts(30), 14);
		assert.strictEqual(trackOffset(container), `translateY(${-7 * SPACING}px)`);
		assert.strictEqual(dots(container).findIndex(dot => dot.classList.contains('active')), 14);
		assert.deepStrictEqual(visibleIndices(container), Array.from({ length: VISIBLE_DOTS }, (_, index) => index + 7));

		// The last prompt keeps the window on the tail instead of scrolling past it.
		rail.update(prompts(30), 29);
		assert.strictEqual(trackOffset(container), `translateY(${-15 * SPACING}px)`);
		assert.strictEqual(dots(container).findIndex(dot => dot.classList.contains('active')), 29);
		assert.deepStrictEqual(visibleIndices(container), Array.from({ length: VISIBLE_DOTS }, (_, index) => index + 15));

		// An out-of-range active index is clamped rather than dropping the window.
		rail.update(prompts(30), 99);
		assert.strictEqual(trackOffset(container), `translateY(${-15 * SPACING}px)`);
		assert.strictEqual(dots(container).findIndex(dot => dot.classList.contains('active')), 29);
	});

	test('fades the dots at the edges of the window and hides the ones outside it', () => {
		const { rail, container } = createRail();

		rail.update(prompts(30), 14);

		const rendered = dots(container);
		// Prompt 15 (index 14) is centred, so the window covers indices 7 through 21.
		assert.strictEqual(rendered[0].style.visibility, 'hidden');
		assert.strictEqual(rendered[0].style.pointerEvents, 'none');
		assert.strictEqual(rendered[6].style.visibility, 'hidden');
		assert.strictEqual(rendered[22].style.visibility, 'hidden');
		assert.strictEqual(rendered[22].style.pointerEvents, 'none');
		assert.strictEqual(rendered[29].style.visibility, 'hidden');

		// Every dot inside the window stays visible, at the edge most faded.
		assert.deepStrictEqual(visibleIndices(container), Array.from({ length: VISIBLE_DOTS }, (_, index) => index + 7));
		assert.strictEqual(rendered[7].style.visibility, '');
		assert.strictEqual(rendered[7].style.opacity, '0.4');
		assert.strictEqual(rendered[7].style.filter, '');

		// Half a fade zone in, the dot is dimmed.
		assert.strictEqual(rendered[8].style.opacity, '0.7');
		assert.strictEqual(rendered[8].style.filter, '');

		// A full fade zone in, the dot is fully opaque.
		assert.strictEqual(rendered[9].style.opacity, '1');
		assert.strictEqual(rendered[9].style.filter, '');

		// The bottom edge mirrors the top edge.
		assert.strictEqual(rendered[20].style.opacity, '0.7');
		assert.strictEqual(rendered[20].style.filter, '');
		assert.strictEqual(rendered[21].style.opacity, '0.4');
		assert.strictEqual(rendered[21].style.filter, '');
	});

	test('reports the prompt index when a dot is clicked and ignores other clicks', () => {
		const { rail, container } = createRail();
		const clicked: number[] = [];
		const subscription = rail.onDidClickPrompt(index => clicked.push(index));
		store.add(toDisposable(() => subscription.dispose()));

		rail.update(prompts(30), 0);
		const rendered = dots(container);

		rendered[3].dispatchEvent(new MouseEvent('click', { bubbles: true }));
		assert.deepStrictEqual(clicked, [3]);

		// Clicks on the rail's own chrome are not prompt navigation.
		railElement(container).dispatchEvent(new MouseEvent('click', { bubbles: true }));
		container.querySelector<HTMLElement>('.chat-prompt-dot-viewport')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		assert.deepStrictEqual(clicked, [3]);

		// A dot parked outside the window is inert in the DOM too.
		assert.strictEqual(rendered[29].style.pointerEvents, 'none');
	});

	test('scrolls the transcript for wheel gestures anywhere on the rail', () => {
		const { rail, container } = createRail();
		const deltas: number[] = [];
		const subscription = rail.onDidScroll(delta => deltas.push(delta));
		store.add(toDisposable(() => subscription.dispose()));

		let bubbled = 0;
		container.addEventListener('wheel', () => bubbled++);

		rail.update(prompts(30), 0);
		const rendered = dots(container);
		const viewport = container.querySelector<HTMLElement>('.chat-prompt-dot-viewport');
		assert.ok(viewport);

		// Pixel deltas pass through unchanged, wherever the cursor sits.
		const overDot = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
		rendered[4].dispatchEvent(overDot);
		assert.deepStrictEqual(deltas, [120]);
		assert.strictEqual(overDot.defaultPrevented, true);
		assert.strictEqual(bubbled, 0, 'the rail must own the gesture instead of letting it reach the transcript');

		viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -180, bubbles: true, cancelable: true }));
		assert.deepStrictEqual(deltas, [120, -180]);

		// Line and page deltas are converted to pixels.
		viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, bubbles: true, cancelable: true }));
		assert.deepStrictEqual(deltas, [120, -180, 3 * SPACING]);
	});

	test('removes the rail from its container when disposed', () => {
		const { rail, container } = createRail();
		rail.update(prompts(2), 0);
		assert.ok(container.querySelector('.chat-prompt-dot-rail'));

		rail.dispose();
		assert.strictEqual(container.querySelector('.chat-prompt-dot-rail'), null);
	});
});

suite('ChatPromptDotRail window and active prompt maths', () => {

	test('centres the window on the active dot and clamps it to the list', () => {
		assert.strictEqual(promptWindowStart(30, 14, 15), 7);
		assert.strictEqual(promptWindowStart(30, 0, 15), 0);
		assert.strictEqual(promptWindowStart(30, 7, 15), 0);
		assert.strictEqual(promptWindowStart(30, 22, 15), 15);
		assert.strictEqual(promptWindowStart(30, 29, 15), 15);
		// A transcript shorter than the window never scrolls.
		assert.strictEqual(promptWindowStart(15, 7, 15), 0);
		assert.strictEqual(promptWindowStart(5, 3, 15), 0);
		assert.strictEqual(promptWindowStart(0, 0, 15), 0);
		// Out-of-range indices clamp instead of producing a negative window.
		assert.strictEqual(promptWindowStart(30, -5, 15), 0);
		assert.strictEqual(promptWindowStart(30, 99, 15), 15);
	});

	test('tracks the prompt at the top of the viewport', () => {
		const offsets = [0, 100, 250, 900];

		assert.strictEqual(activePromptIndex([], 0), 0);
		assert.strictEqual(activePromptIndex(offsets, 0), 0);
		assert.strictEqual(activePromptIndex(offsets, 90), 0);
		assert.strictEqual(activePromptIndex(offsets, 100), 1);
		assert.strictEqual(activePromptIndex(offsets, 240), 1);
		// A row the scroll landed a hair above still counts as reached.
		assert.strictEqual(activePromptIndex(offsets, 246), 2);
		assert.strictEqual(activePromptIndex(offsets, 900), 3);
		assert.strictEqual(activePromptIndex(offsets, 5000), 3);
	});
});
