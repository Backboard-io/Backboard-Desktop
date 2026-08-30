/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Event } from '../../../../../../base/common/event.js';
import { constObservable, observableValue } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ResolveSessionConfigResult } from '../../../../../../platform/agentHost/common/state/protocol/commands.js';
import { IToastOptions, IToastResult } from '../../../../../../platform/native/common/native.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IWindowOpenable, IOpenWindowOptions, IOpenEmptyWindowOptions } from '../../../../../../platform/window/common/window.js';
import { IHostService } from '../../../../../../workbench/services/host/browser/host.js';
import { IAgentHostSessionsProvider } from '../../../../../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../../../services/sessions/browser/sessionsService.js';
import { ISession, SessionStatus } from '../../../../../services/sessions/common/session.js';
import { AgentHostTurnNotifierContribution } from '../../browser/agentHostTurnNotifier.js';

const PROVIDER_ID = 'local-agent-host';
const SESSION_ID = 'local-agent-host:s1';

suite('AgentHostTurnNotifier', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function makeHarness(options: { notifications: unknown; hasFocus: boolean }) {
		const status = observableValue<SessionStatus>('status', SessionStatus.Untitled);
		const session = new class extends mock<ISession>() {
			override sessionId = SESSION_ID;
			override providerId = PROVIDER_ID;
			override resource = URI.parse('backboard-session:/s1');
			override title = constObservable('My Session');
			override status = status;
		}();

		const provider = new class extends mock<IAgentHostSessionsProvider>() {
			override id = PROVIDER_ID;
			override onDidChangeSessions = Event.None;
			override getSessions(): ISession[] { return [session]; }
			override getSessionConfig(sessionId: string): ResolveSessionConfigResult | undefined {
				assert.strictEqual(sessionId, SESSION_ID);
				return { schema: { type: 'object', properties: {} }, values: { notifications: options.notifications } };
			}
		}();

		const toasts: IToastOptions[] = [];
		const focusModes: (string | undefined)[] = [];
		const opened: URI[] = [];

		const hostService = new class extends mock<IHostService>() {
			override hasFocus = options.hasFocus;
			override async focus(_window: Window, focusOptions?: { mode?: unknown }): Promise<void> {
				focusModes.push(typeof focusOptions?.mode === 'number' ? String(focusOptions.mode) : undefined);
			}
			override async showToast(toastOptions: IToastOptions, _token: CancellationToken): Promise<IToastResult> {
				toasts.push(toastOptions);
				return { supported: true, clicked: true };
			}
			override openWindow(_arg1?: IOpenEmptyWindowOptions | IWindowOpenable[], _arg2?: IOpenWindowOptions): Promise<void> {
				return Promise.resolve();
			}
		}();

		const providersService = new class extends mock<ISessionsProvidersService>() {
			override onDidChangeProviders = Event.None;
			override getProviders() { return [provider]; }
		}();

		const sessionsService = new class extends mock<ISessionsService>() {
			override async openSession(sessionResource: URI): Promise<void> {
				opened.push(sessionResource);
			}
		}();

		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ISessionsProvidersService, providersService);
		instantiationService.stub(ISessionsService, sessionsService);
		instantiationService.stub(IHostService, hostService);

		const notifier = store.add(instantiationService.createInstance(AgentHostTurnNotifierContribution));

		return { status, toasts, opened, notifier };
	}

	async function settle(predicate: () => boolean): Promise<void> {
		for (let i = 0; i < 50 && !predicate(); i++) {
			await timeout(1);
		}
	}

	test('toasts when a turn completes unfocused and opens the session on click', async () => {
		const { status, toasts, opened } = makeHarness({ notifications: true, hasFocus: false });

		status.set(SessionStatus.InProgress, undefined);
		status.set(SessionStatus.Completed, undefined);
		await settle(() => opened.length > 0);

		assert.strictEqual(toasts.length, 1);
		assert.strictEqual(toasts[0].title, 'My Session');
		assert.deepStrictEqual(opened.map(String), ['backboard-session:/s1']);
	});

	test('stays silent when the toggle is off, when focused, or without a running turn', async () => {
		const toggledOff = makeHarness({ notifications: false, hasFocus: false });
		toggledOff.status.set(SessionStatus.InProgress, undefined);
		toggledOff.status.set(SessionStatus.Completed, undefined);

		const focused = makeHarness({ notifications: true, hasFocus: true });
		focused.status.set(SessionStatus.InProgress, undefined);
		focused.status.set(SessionStatus.Error, undefined);

		// Hydration straight to Completed (no InProgress first) must not notify.
		const hydrated = makeHarness({ notifications: true, hasFocus: false });
		hydrated.status.set(SessionStatus.Completed, undefined);

		await timeout(10);
		assert.deepStrictEqual(
			[toggledOff.toasts.length, focused.toasts.length, hydrated.toasts.length],
			[0, 0, 0],
		);
	});
});
