/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';

suite('BackboardWorkspacePage structure', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const source = readFileSync(join(process.cwd(), 'src/vs/workbench/contrib/chat/electron-browser/backboardWorkspace/backboardWorkspacePage.ts'), 'utf8');

	function createBody(): string {
		const start = source.indexOf('\n\tcreate(parent: HTMLElement): void {');
		assert.ok(start >= 0, 'Missing BackboardWorkspacePage.create');
		const nextMethod = source.indexOf('\n\tfocus(): void {', start);
		assert.ok(nextMethod > start, 'Could not find end of BackboardWorkspacePage.create');
		return source.slice(start, nextMethod);
	}

	const body = createBody();

	function countOccurrences(value: string): number {
		return body.split(value).length - 1;
	}

	test('creates one top workspace header before the page body', () => {
		assert.strictEqual(countOccurrences("$('.backboard-workspace-header')"), 1);
		assert.strictEqual(countOccurrences("$('.backboard-workspace-page')"), 1);

		const headerIndex = body.indexOf("$('.backboard-workspace-header')");
		const pageIndex = body.indexOf("$('.backboard-workspace-page')");
		assert.ok(headerIndex >= 0, 'Missing workspace header');
		assert.ok(pageIndex >= 0, 'Missing workspace page');
		assert.ok(headerIndex < pageIndex, 'Workspace header must be appended before page body so it stays at the top');
	});

	test('puts workspace switcher, title, count, and controls in the header', () => {
		const headerIndex = body.indexOf("$('.backboard-workspace-header')");
		const pageIndex = body.indexOf("$('.backboard-workspace-page')");
		const headerBody = body.slice(headerIndex, pageIndex);

		assert.match(headerBody, /backboard-workspace-header-left/);
		assert.match(headerBody, /backboard-workspace-header-right/);
		assert.match(headerBody, /button\.backboard-workspace-switcher/);
		assert.match(headerBody, /backboard-workspace-title-row/);
		assert.match(headerBody, /backboard-workspace-count/);
		assert.match(headerBody, /backboard-workspace-detail-new-button/);
		assert.match(headerBody, /backboard-workspace-detail-toggle/);
		assert.match(headerBody, /backboard-workspace-detail-expand/);
		assert.match(headerBody, /codicon-refresh/);
	});

	test('creates cards after the header inside main and keeps detail as a page sibling', () => {
		const pageIndex = body.indexOf("$('.backboard-workspace-page')");
		const mainIndex = body.indexOf("$('.backboard-workspace-main')", pageIndex);
		const cardsIndex = body.indexOf("$('.backboard-workspace-cards')", mainIndex);
		const sashIndex = body.indexOf("$('div.backboard-workspace-sash')", cardsIndex);
		const detailIndex = body.indexOf("$('.backboard-workspace-detail')", sashIndex);
		const chatIndex = body.indexOf("$('.backboard-workspace-detail-chat')", detailIndex);

		assert.ok(pageIndex >= 0, 'Missing page');
		assert.ok(mainIndex > pageIndex, 'Main workspace must be inside page');
		assert.ok(cardsIndex > mainIndex, 'Cards container must be inside main workspace');
		assert.ok(sashIndex > cardsIndex, 'Sash must be after cards/main');
		assert.ok(detailIndex > sashIndex, 'Detail panel must be a page sibling after the sash, not nested in the card grid');
		assert.ok(chatIndex > detailIndex, 'Detail chat container must remain inside the detail panel');
	});

	test('does not create a duplicate bottom toolbar after the cards', () => {
		const cardsIndex = body.indexOf("$('.backboard-workspace-cards')");
		assert.ok(cardsIndex >= 0, 'Missing cards container');
		const afterCards = body.slice(cardsIndex);

		assert.strictEqual((afterCards.match(/backboard-workspace-header/g) ?? []).length, 0);
		assert.strictEqual((afterCards.match(/backboard-workspace-title-row/g) ?? []).length, 0);
		assert.strictEqual((afterCards.match(/button\.backboard-workspace-switcher/g) ?? []).length, 0);
	});

	test('keeps overlap-prone header text in ellipsizable wrapper elements', () => {
		assert.match(body, /this\.workspaceSwitcherLabel = append\(this\.workspaceSwitcherButton, \$\('span'\)\)/);
		assert.match(body, /const titleRow = append\(headerLeft, \$\('\.backboard-workspace-title-row'\)\)/);
		assert.match(body, /this\.countElement = append\(titleRow, \$\('\.backboard-workspace-count'\)\)/);
		assert.match(body, /this\.detailTitleElement = append\(headerRight, \$\('h2\.backboard-workspace-detail-title'\)\)/);
	});
});
