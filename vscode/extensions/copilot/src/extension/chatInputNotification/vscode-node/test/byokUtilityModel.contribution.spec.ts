/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { Emitter } from '../../../../util/vs/base/common/event';

// ---- vscode mock -----------------------------------------------------------

const mockNotification = {
	severity: 0,
	dismissible: false,
	autoDismissOnMessage: false,
	message: '',
	description: '',
	actions: [] as { label: string; commandId: string; commandArgs?: unknown[] }[],
	show: vi.fn(),
	hide: vi.fn(),
	dispose: vi.fn(),
};

const onDidChangeChatModelsEmitter = new Emitter<void>();
const selectChatModelsMock = vi.fn();

vi.mock('vscode', () => ({
	ChatInputNotificationSeverity: { Info: 1 },
	chat: {
		createInputNotification: vi.fn(() => mockNotification),
	},
	lm: {
		get onDidChangeChatModels() { return onDidChangeChatModelsEmitter.event; },
		selectChatModels: (...args: unknown[]) => selectChatModelsMock(...args),
	},
	l10n: { t: (str: string, ...args: unknown[]) => str.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)])) },
}));

import { ByokUtilityModelNotificationContribution } from '../byokUtilityModel.contribution';

// ---- helpers ---------------------------------------------------------------

function createAuthService(opts?: { anyGitHubSession?: unknown }) {
	const emitter = new Emitter<void>();
	const hasSession = opts && 'anyGitHubSession' in opts;
	const authService = {
		_serviceBrand: undefined,
		anyGitHubSession: hasSession ? opts!.anyGitHubSession : undefined,
		onDidAuthenticationChange: emitter.event,
	} as unknown as IAuthenticationService;
	return { authService, emitter };
}

function createConfigService(values: Record<string, unknown> = {}) {
	const emitter = new Emitter<{ affectsConfiguration: (key: string) => boolean }>();
	const store = new Map<string, unknown>(Object.entries(values));
	const configService = {
		_serviceBrand: undefined,
		getNonExtensionConfig: <T,>(key: string) => store.get(key) as T | undefined,
		onDidChangeConfiguration: emitter.event,
	} as unknown as IConfigurationService;
	const set = (key: string, value: unknown) => {
		if (value === undefined) {
			store.delete(key);
		} else {
			store.set(key, value);
		}
		emitter.fire({ affectsConfiguration: (k: string) => k === key });
	};
	return { configService, set };
}

async function flushAsync() {
	// Drain microtasks so async _update() observers complete.
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

// ---- tests -----------------------------------------------------------------

describe('ByokUtilityModelNotificationContribution', () => {
	let contribution: ByokUtilityModelNotificationContribution | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		mockNotification.show.mockClear();
		mockNotification.hide.mockClear();
		mockNotification.message = '';
		mockNotification.description = '';
		mockNotification.actions = [];
		selectChatModelsMock.mockResolvedValue([{ vendor: 'ollama', id: 'llama3' }]);
	});

	afterEach(() => {
		contribution?.dispose();
		contribution = undefined;
	});

	test('does not show notification when signed out + BYOK + utility settings unset', async () => {
		const { authService } = createAuthService({ anyGitHubSession: undefined });
		const { configService } = createConfigService();
		contribution = new ByokUtilityModelNotificationContribution(authService, configService);

		await flushAsync();

		expect(mockNotification.show).not.toHaveBeenCalled();
	});

	test('does not show notification when only chat.utilityModel is unset', async () => {
		const { authService } = createAuthService({ anyGitHubSession: undefined });
		const { configService } = createConfigService({ 'chat.utilitySmallModel': 'ollama/llama3' });
		contribution = new ByokUtilityModelNotificationContribution(authService, configService);

		await flushAsync();

		expect(mockNotification.show).not.toHaveBeenCalled();
	});

	test('does not show notification when signed in', async () => {
		const { authService } = createAuthService({ anyGitHubSession: { accessToken: 'tok' } });
		const { configService } = createConfigService();
		contribution = new ByokUtilityModelNotificationContribution(authService, configService);

		await flushAsync();

		expect(mockNotification.show).not.toHaveBeenCalled();
	});

	test('does not show notification when no BYOK models are registered', async () => {
		selectChatModelsMock.mockResolvedValue([{ vendor: 'copilot', id: 'gpt-4' }]);
		const { authService } = createAuthService({ anyGitHubSession: undefined });
		const { configService } = createConfigService();
		contribution = new ByokUtilityModelNotificationContribution(authService, configService);

		await flushAsync();

		expect(mockNotification.show).not.toHaveBeenCalled();
	});

	test('does not show notification when both utility settings are configured', async () => {
		const { authService } = createAuthService({ anyGitHubSession: undefined });
		const { configService } = createConfigService({
			'chat.utilityModel': 'ollama/llama3',
			'chat.utilitySmallModel': 'ollama/llama3',
		});
		contribution = new ByokUtilityModelNotificationContribution(authService, configService);

		await flushAsync();

		expect(mockNotification.show).not.toHaveBeenCalled();
	});

	test('hides notification once both utility settings are configured', async () => {
		const { authService } = createAuthService({ anyGitHubSession: undefined });
		const { configService, set } = createConfigService();
		contribution = new ByokUtilityModelNotificationContribution(authService, configService);

		await flushAsync();
		expect(mockNotification.show).not.toHaveBeenCalled();

		set('chat.utilityModel', 'ollama/llama3');
		await flushAsync();
		expect(mockNotification.show).not.toHaveBeenCalled();

		set('chat.utilitySmallModel', 'ollama/llama3');
		await flushAsync();
		expect(mockNotification.show).not.toHaveBeenCalled();
	});

	test('hides notification when user signs in', async () => {
		const { authService, emitter } = createAuthService({ anyGitHubSession: undefined });
		const { configService } = createConfigService();
		contribution = new ByokUtilityModelNotificationContribution(authService, configService);

		await flushAsync();
		expect(mockNotification.show).not.toHaveBeenCalled();

		(authService as unknown as { anyGitHubSession: unknown }).anyGitHubSession = { accessToken: 'tok' };
		emitter.fire();
		await flushAsync();

		expect(mockNotification.show).not.toHaveBeenCalled();
	});
});
