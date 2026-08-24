/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { getMarks } from '../../../../../base/common/performance.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LogLevel, NullLogService } from '../../../../../platform/log/common/log.js';
import { ChatPerfMark, clearChatMarks, isChatPerfLoggingEnabled, logChatPerf, markChat } from '../../common/chatPerf.js';

class CapturingLogService extends NullLogService {
	readonly traceMessages: string[] = [];
	readonly debugMessages: string[] = [];

	constructor(private readonly level: LogLevel) {
		super();
	}

	override getLevel(): LogLevel { return this.level; }
	override trace(message: string): void { this.traceMessages.push(message); }
	override debug(message: string): void { this.debugMessages.push(message); }
}

suite('chatPerf', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let sessionResource: URI;

	setup(() => {
		sessionResource = URI.parse(`test://session/${Date.now()}`);
	});

	teardown(() => {
		clearChatMarks(sessionResource);
	});

	test('markChat emits a mark with the expected prefix', () => {
		markChat(sessionResource, ChatPerfMark.RequestStart);

		const marks = getMarks().filter(m => m.name.includes(sessionResource.toString()));
		assert.strictEqual(marks.length, 1);
		assert.ok(marks[0].name.startsWith('code/chat/'));
		assert.ok(marks[0].name.endsWith('/request/start'));
	});

	test('clearChatMarks removes all marks for the session', () => {
		markChat(sessionResource, ChatPerfMark.RequestStart);
		markChat(sessionResource, ChatPerfMark.FirstToken);

		clearChatMarks(sessionResource);

		const marks = getMarks().filter(m => m.name.includes(sessionResource.toString()));
		assert.strictEqual(marks.length, 0);
	});

	test('clearChatMarks does not affect marks from a different session', () => {
		const otherSession = URI.parse(`test://session/other-${Date.now()}`);
		markChat(sessionResource, ChatPerfMark.RequestStart);
		markChat(otherSession, ChatPerfMark.FirstToken);

		clearChatMarks(sessionResource);

		const remaining = getMarks().filter(m => m.name.includes(otherSession.toString()));
		assert.strictEqual(remaining.length, 1);

		clearChatMarks(otherSession);
	});

	test('renderer diagnostics are dormant below Debug', () => {
		const logService = new CapturingLogService(LogLevel.Info);
		let detailsRead = false;
		const details = Object.defineProperty({}, 'item', {
			enumerable: true,
			get: () => {
				detailsRead = true;
				return 'response-1';
			},
		});

		assert.strictEqual(isChatPerfLoggingEnabled(logService), false);
		logChatPerf(logService, 'item.render', details, 50);

		assert.strictEqual(detailsRead, false);
		assert.deepStrictEqual(logService.traceMessages, []);
		assert.deepStrictEqual(logService.debugMessages, []);
	});

	test('Debug filters fast timings but keeps slow and lifecycle events', () => {
		const logService = new CapturingLogService(LogLevel.Debug);

		logChatPerf(logService, 'item.render', { item: 'response-1' }, 5);
		logChatPerf(logService, 'item.render', { item: 'response-1' }, 20);
		logChatPerf(logService, 'editor.coldRelease', { session: 'session-1' });

		assert.deepStrictEqual(logService.traceMessages, []);
		assert.strictEqual(logService.debugMessages.length, 2);
		assert.match(logService.debugMessages[0], /event=item\.render durationMs=20\.0 item="response-1"/);
		assert.match(logService.debugMessages[1], /event=editor\.coldRelease session="session-1"/);
	});

	test('Trace keeps caller-selected fast samples', () => {
		const logService = new CapturingLogService(LogLevel.Trace);

		logChatPerf(logService, 'markdown.stream', { chars: 1200, final: false }, 0.25);

		assert.deepStrictEqual(logService.debugMessages, []);
		assert.strictEqual(logService.traceMessages.length, 1);
		assert.match(logService.traceMessages[0], /event=markdown\.stream durationMs=0\.3 chars=1200 final=false/);
	});
});
