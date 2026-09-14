/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ByokKeyOperationOutcome, IByokKeyStatus, IByokKeyStore, maskKey } from '../../../../../../platform/agentHost/common/byokKeyStore.js';
import { ByokProviderId } from '../../../../../../platform/agentHost/common/byokProviders.js';
import { IMainProcessService } from '../../../../../../platform/ipc/common/mainProcessService.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { ByokKeyValidationError } from '../../../browser/agentSessions/agentHost/byokKeysService.js';
import { ByokKeysService } from '../../../electron-browser/agentSessions/byokKeysService.js';

const KEY = 'sk-test-1234567890abcdef';

function status(provider: ByokProviderId, overrides: Partial<IByokKeyStatus> = {}): IByokKeyStatus {
	return { provider, label: provider, keyHint: 'sk-…', consoleUrl: 'https://example.test', configured: false, connected: false, persistence: 'persisted', ...overrides };
}

/** Stands in for the main-process owner: answers from canned statuses and outcomes. */
class TestStore implements IByokKeyStore {
	readonly changes = new Emitter<readonly IByokKeyStatus[]>();
	readonly onDidChange = this.changes.event;
	readonly calls: string[] = [];
	statuses: readonly IByokKeyStatus[] = [status('openai'), status('anthropic')];
	readonly outcomes = new Map<string, ByokKeyOperationOutcome>();

	async list(): Promise<readonly IByokKeyStatus[]> {
		return this.statuses;
	}

	async add(provider: ByokProviderId, key: string): Promise<ByokKeyOperationOutcome> {
		this.calls.push(`add:${provider}:${key}`);
		return this.outcomes.get(`add:${provider}`) ?? { ok: true };
	}

	async remove(provider: ByokProviderId): Promise<ByokKeyOperationOutcome> {
		this.calls.push(`remove:${provider}`);
		return this.outcomes.get(`remove:${provider}`) ?? { ok: true };
	}

	async test(provider: ByokProviderId): Promise<ByokKeyOperationOutcome> {
		this.calls.push(`test:${provider}`);
		return this.outcomes.get(`test:${provider}`) ?? { ok: true };
	}
}

class TestByokKeysService extends ByokKeysService {
	static nextStore: IByokKeyStore | undefined;

	protected override _createStore(): IByokKeyStore {
		return TestByokKeysService.nextStore!;
	}
}

suite('ByokKeysService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(initialStatuses?: readonly IByokKeyStatus[]) {
		const owner = new TestStore();
		if (initialStatuses) {
			owner.statuses = initialStatuses;
		}
		store.add(owner.changes);
		TestByokKeysService.nextStore = owner;
		const service = store.add(new TestByokKeysService({} as Partial<IMainProcessService> as IMainProcessService, new NullLogService()));
		TestByokKeysService.nextStore = undefined;
		return { service, owner };
	}

	test('shows every provider before the owner answers, then adopts its statuses', async () => {
		const { service } = createService([status('openai', { configured: true, connected: true, masked: 'sk-test…cdef' }), status('anthropic')]);
		const immediate = service.list().map(entry => [entry.provider, entry.configured]);

		await new Promise<void>(resolve => store.add(service.onDidChange(() => resolve())));

		assert.deepStrictEqual({ immediate, adopted: service.list().map(entry => [entry.provider, entry.configured, entry.masked]) }, {
			immediate: [['openai', false], ['anthropic', false]],
			adopted: [['openai', true, 'sk-test…cdef'], ['anthropic', false, undefined]],
		});
	});

	test('reflects changes pushed by the owner, wherever they were made', async () => {
		const { service, owner } = createService();
		let changes = 0;
		store.add(service.onDidChange(() => changes++));

		owner.changes.fire([status('openai', { configured: true, connected: false }), status('anthropic')]);

		assert.deepStrictEqual({ changes, openai: service.list().find(entry => entry.provider === 'openai')?.connected }, { changes: 1, openai: false });
	});

	test('passes a new key straight through and turns a rejection into a typed error', async () => {
		const { service, owner } = createService();
		owner.outcomes.set('add:openai', { ok: false, message: 'OpenAI rejected that key.', category: 'invalid-key' });

		const failure = await service.add('openai', KEY).catch(error => error);

		assert.deepStrictEqual({
			calls: owner.calls,
			category: failure instanceof ByokKeyValidationError ? failure.category : undefined,
			message: failure instanceof Error ? failure.message : undefined,
		}, {
			calls: [`add:openai:${KEY}`],
			category: 'invalid-key',
			message: 'OpenAI rejected that key.',
		});
	});

	test('surfaces a removal the runtime could not confirm and a failed test', async () => {
		const { service, owner } = createService();
		owner.outcomes.set('remove:openai', { ok: false, message: 'A session could not confirm dropping it.', category: 'runtime' });
		owner.outcomes.set('test:openai', { ok: false, message: 'Rejected on test.', category: 'invalid-key' });

		const removal = await service.remove('openai').catch(error => error);
		const test = await service.test('openai').catch(error => error);
		await service.remove('anthropic');

		assert.deepStrictEqual({
			calls: owner.calls,
			removal: removal instanceof Error ? removal.message : undefined,
			test: test instanceof ByokKeyValidationError ? test.category : undefined,
		}, {
			calls: ['remove:openai', 'test:openai', 'remove:anthropic'],
			removal: 'A session could not confirm dropping it.',
			test: 'invalid-key',
		});
	});

	test('masks keys the way the CLI does', () => {
		assert.deepStrictEqual([maskKey(KEY), maskKey('short')], ['sk-test…cdef', '*****']);
	});
});
