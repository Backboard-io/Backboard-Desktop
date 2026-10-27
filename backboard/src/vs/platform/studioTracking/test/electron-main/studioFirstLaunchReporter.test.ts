/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { bufferToStream, VSBuffer } from '../../../../base/common/buffer.js';
import { IRequestContext, IRequestOptions } from '../../../../base/parts/request/common/request.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { IEnvironmentMainService } from '../../../environment/electron-main/environmentMainService.js';
import { NullLogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { IRequestService } from '../../../request/common/request.js';
import { IStateService } from '../../../state/node/state.js';
import { StorageScope } from '../../../storage/common/storage.js';
import { IApplicationStorageMainService } from '../../../storage/electron-main/storageMainService.js';
import { firstSessionDateStorageKey } from '../../../telemetry/common/telemetry.js';
import { IStudioProcess, STUDIO_FIRST_LAUNCH_REPORTED_KEY, STUDIO_INSTALLATION_ID_KEY, STUDIO_PRODUCTION_API_URL, StudioFirstLaunchReporter, studioPlatform } from '../../electron-main/studioFirstLaunchReporter.js';

const FIRST_SESSION = 'Tue, 01 Sep 2026 10:00:00 GMT';
const LOCAL_API = 'http://localhost:8000';

class TestState {
	readonly items = new Map<string, unknown>();

	getItem<T>(key: string, defaultValue?: T): T | undefined {
		return this.items.has(key) ? this.items.get(key) as T : defaultValue;
	}

	setItem(key: string, data: unknown): void {
		this.items.set(key, data);
	}

	asService(): IStateService {
		return this as unknown as IStateService;
	}
}

class TestApplicationStorage {
	readonly whenReady = Promise.resolve();

	constructor(private readonly _firstSession: string | undefined) { }

	get(key: string, _scope: StorageScope): string | undefined {
		return key === firstSessionDateStorageKey ? this._firstSession : undefined;
	}

	asService(): IApplicationStorageMainService {
		return this as unknown as IApplicationStorageMainService;
	}
}

class TestRequests {
	readonly sent: IRequestOptions[] = [];
	respond: () => Promise<number> = async () => 204;

	async request(options: IRequestOptions): Promise<IRequestContext> {
		this.sent.push(options);
		const statusCode = await this.respond();
		return { res: { headers: {}, statusCode }, stream: bufferToStream(VSBuffer.fromString('')) };
	}

	body(index = 0): Record<string, unknown> {
		return JSON.parse(this.sent[index].data!);
	}

	asService(): IRequestService {
		return this as unknown as IRequestService;
	}
}

interface IFixtureOptions {
	readonly built?: boolean;
	readonly disableTelemetry?: boolean;
	readonly configuration?: Record<string, unknown>;
	readonly firstSession?: string;
	readonly product?: Partial<IProductService>;
	readonly process?: Partial<IStudioProcess>;
}

suite('StudioFirstLaunchReporter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function createFixture(options: IFixtureOptions = {}) {
		const state = new TestState();
		const requests = new TestRequests();
		const studioProcess: IStudioProcess = { env: {}, platform: 'darwin', arch: 'arm64', ...options.process };
		const environment = { isBuilt: options.built ?? true, disableTelemetry: options.disableTelemetry ?? false } as Partial<IEnvironmentMainService> as IEnvironmentMainService;
		const product = { backboardVersion: '3.1.26', backboardUpdateChannel: 'stable', ...options.product } as Partial<IProductService> as IProductService;
		const reporter = new StudioFirstLaunchReporter(
			studioProcess,
			state.asService(),
			new TestApplicationStorage(options.firstSession ?? FIRST_SESSION).asService(),
			requests.asService(),
			product,
			new TestConfigurationService(options.configuration),
			environment,
			new NullLogService(),
		);
		return { reporter, state, requests };
	}

	test('a built app reports the first launch once, with its release details', async () => {
		const { reporter, state, requests } = createFixture();

		await reporter.report();
		await reporter.report();

		assert.strictEqual(requests.sent.length, 1);
		const [request] = requests.sent;
		const installationId = state.getItem<string>(STUDIO_INSTALLATION_ID_KEY);
		assert.deepStrictEqual({
			type: request.type,
			url: request.url,
			clientHeader: request.headers?.['X-Backboard-Client'],
			body: requests.body(),
			reported: state.getItem(STUDIO_FIRST_LAUNCH_REPORTED_KEY),
		}, {
			type: 'POST',
			url: `${STUDIO_PRODUCTION_API_URL}/studio/events/first-launch`,
			clientHeader: 'studio/3.1.26',
			body: {
				installation_id: installationId,
				platform: 'macos-aarch64',
				version: '3.1.26',
				channel: 'stable',
				first_session_at: '2026-09-01T10:00:00.000Z',
			},
			reported: true,
		});
		assert.match(installationId!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	test('a rejected or failed report is retried on the next start with the same installation id', async () => {
		const { reporter, state, requests } = createFixture();
		requests.respond = async () => 429;
		await reporter.report();
		requests.respond = async () => { throw new Error('offline'); };
		await reporter.report();
		requests.respond = async () => 204;
		await reporter.report();

		assert.strictEqual(requests.sent.length, 3);
		assert.deepStrictEqual(new Set(requests.sent.map((_request, index) => requests.body(index).installation_id)).size, 1);
		assert.strictEqual(state.getItem(STUDIO_FIRST_LAUNCH_REPORTED_KEY), true);
	});

	for (const configuration of [{ 'telemetry.telemetryLevel': 'error' }, { 'telemetry.telemetryLevel': 'off' }, { 'telemetry.enableTelemetry': false }]) {
		test(`usage telemetry opt-out sends nothing: ${JSON.stringify(configuration)}`, async () => {
			const { reporter, state, requests } = createFixture({ configuration });

			await reporter.report();

			assert.deepStrictEqual({ sent: requests.sent.length, installationId: state.getItem(STUDIO_INSTALLATION_ID_KEY) }, { sent: 0, installationId: undefined });
		});
	}

	test('--disable-telemetry sends nothing', async () => {
		const { reporter, requests } = createFixture({ disableTelemetry: true });

		await reporter.report();

		assert.strictEqual(requests.sent.length, 0);
	});

	test('dev builds report only when pointed at an API', async () => {
		const silent = createFixture({ built: false, product: { backboardUpdateChannel: undefined } });
		await silent.reporter.report();

		const pointed = createFixture({ built: false, product: { backboardUpdateChannel: undefined }, process: { env: { BACKBOARD_STUDIO_TRACKING_API_URL: LOCAL_API } } });
		await pointed.reporter.report();

		assert.strictEqual(silent.requests.sent.length, 0);
		assert.strictEqual(pointed.requests.sent[0].url, `${LOCAL_API}/studio/events/first-launch`);
		assert.strictEqual(pointed.requests.body().channel, 'dev');
	});

	test('an unreadable first session date is left out', async () => {
		const { reporter, requests } = createFixture({ firstSession: 'not a date' });

		await reporter.report();

		assert.strictEqual(requests.body().first_session_at, undefined);
	});

	test('a Microsoft Store install is marked as such', async () => {
		const { reporter, requests } = createFixture({ process: { platform: 'win32', arch: 'x64', windowsStore: true } });

		await reporter.report();

		assert.deepStrictEqual({ platform: requests.body().platform, package: requests.body().package }, { platform: 'windows-x86_64', package: 'store' });
	});

	test('an unsupported platform sends nothing', async () => {
		const { reporter, requests } = createFixture({ process: { platform: 'win32', arch: 'ia32' } });

		await reporter.report();

		assert.strictEqual(requests.sent.length, 0);
	});

	test('platform names follow the release bucket', () => {
		assert.deepStrictEqual(
			[['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['win32', 'arm64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'ia32'], ['freebsd', 'x64']].map(([platform, arch]) => studioPlatform(platform, arch)),
			['macos-aarch64', 'macos-x86_64', 'windows-x86_64', 'windows-aarch64', 'linux-x86_64', 'linux-aarch64', undefined, undefined],
		);
	});
});
