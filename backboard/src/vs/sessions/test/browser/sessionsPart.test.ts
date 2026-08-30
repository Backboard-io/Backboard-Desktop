/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { SessionsPart } from '../../browser/parts/sessionsPart.js';
import { Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { SessionsService } from '../../services/sessions/browser/sessionsService.js';

suite('Sessions - Sessions Part', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts a grid layout while visibility state is still stale', () => {
		let layoutContentsArgs: readonly [number, number] | undefined;
		let gridLayoutArgs: readonly [number, number, number, number] | undefined;

		const part = {
			layoutService: {
				// Reproduces the Editor -> Simple ordering where the grid has made
				// the view visible but the layout service has not observed it yet.
				isVisible: (partId: string) => partId !== Parts.SESSIONS_PART,
			},
			layoutContents: (width: number, height: number) => {
				layoutContentsArgs = [width, height];
				return {
					contentSize: { width: width - 2, height: height - 2 },
				};
			},
			_gridWidget: {
				layout: (width: number, height: number, top: number, left: number) => {
					gridLayoutArgs = [width, height, top, left];
				},
			},
		};

		SessionsPart.prototype.layout.call(part as unknown as SessionsPart, 1200, 800, 0, 300);

		assert.deepStrictEqual(layoutContentsArgs, [1198, 798]);
		assert.deepStrictEqual(gridLayoutArgs, [1196, 796, 0, 300]);
	});

	test('Back returns to a parent chat before traversing session history', async () => {
		let sessionHistoryCalls = 0;
		const service = {
			activeSession: { get: () => ({ sessionId: 'session-1' }) },
			sessionsPartService: {
				getSessionView: () => ({ navigateBack: () => true }),
			},
			_navigation: {
				goBack: async () => { sessionHistoryCalls++; },
			},
		};

		await SessionsService.prototype.openPreviousSession.call(service as unknown as SessionsService);

		assert.strictEqual(sessionHistoryCalls, 0);
	});

	test('Back falls through to session history outside a subagent chat', async () => {
		let sessionHistoryCalls = 0;
		const service = {
			activeSession: { get: () => ({ sessionId: 'session-1' }) },
			sessionsPartService: {
				getSessionView: () => ({ navigateBack: () => false }),
			},
			_navigation: {
				goBack: async () => { sessionHistoryCalls++; },
			},
		};

		await SessionsService.prototype.openPreviousSession.call(service as unknown as SessionsService);

		assert.strictEqual(sessionHistoryCalls, 1);
	});
});
