/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { DeferredPromise } from '../../../../base/common/async.js';
import type { CliTsAgentEvent, CliTsWorkerState, CliTsWorkerIntegrationChange } from '../../node/cliTs/cliTsProtocol.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FileService } from '../../../files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentSession, MCP_AUTH_REQUIRED_ERROR_TYPE, type AgentSignal } from '../../common/agentService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { CustomizationType, McpServerStatus, type Customization } from '../../common/state/protocol/channels-session/state.js';
import { buildSubagentSessionUri, FileEditKind, ResponsePartKind, ToolCallConfirmationReason, ToolCallContributorKind, ToolCallStatus, ToolResultContentType, TurnState, type ToolCallResponsePart, type Turn, type ToolResultFileEditContent } from '../../common/state/sessionState.js';
import { AgentHostCheckpointService } from '../../node/agentHostCheckpointService.js';
import { assertUsableClaudeSubscriptionLogin, buildConversationHandoffContext, CliTsAgent, cliTsToolExecutionFailed, getBackboardWorktreeBranchName, getBackboardWorktreesRoot, hasUsableChatGptSubscriptionLogin, isChatGptSubscriptionModel, isClaudeSubscriptionModel, requiresProviderThreadHandoff, withChatGptSubscriptionConnectionState, withClaudeSubscriptionConnectionState } from '../../node/cliTs/cliTsAgent.js';
import { SessionDatabase } from '../../node/sessionDatabase.js';
import { FileEditTracker, parseSessionDbUri } from '../../node/shared/fileEditTracker.js';
import { NullEditSurvivalReporterFactory } from '../../node/shared/editSurvivalReporter.js';
import { createSessionDataService, TestDiffComputeService } from '../common/sessionTestHelpers.js';

/**
 * The calm notes a turn ends with when it could not finish. Failures are
 * never shown as error banners, so these replace `ChatError` actions.
 */
function failureNotes(progress: readonly AgentSignal[]): string[] {
	assert.ok(!progress.some(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatError), 'turn failures must not surface as error banners');
	return progress.flatMap(signal => signal.kind === 'action'
		&& signal.action.type === ActionType.ChatResponsePart
		&& signal.action.part.kind === ResponsePartKind.Markdown
		&& signal.action.part.content.startsWith('_This')
		? [signal.action.part.content] : []);
}

/** The calm note a reopened turn ends with when it did not finish, if any. */
function failureNote(turn: Turn | undefined): string | undefined {
	const last = turn?.responseParts.at(-1);
	return last?.kind === ResponsePartKind.Markdown && last.content.startsWith('_This') ? last.content : undefined;
}

suite('CliTsAgent tool metadata', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createAgent(checkpointService: unknown = {}, sessionDataService: unknown = {}, gitService: unknown = {}, configurationService: unknown = { getSessionConfigValues: () => ({}) }, pluginManager: unknown = { syncCustomizations: async () => [] }, fileService: unknown = {}): CliTsAgent {
		return store.add(new CliTsAgent(
			new NullLogService(),
			configurationService as never,
			sessionDataService as never,
			{} as never,
			checkpointService as never,
			gitService as never,
			pluginManager as never,
			fileService as never,
		));
	}

	function makeFileService(): FileService {
		const log = new NullLogService();
		const service = store.add(new FileService(log));
		store.add(service.registerProvider(Schemas.file, store.add(new DiskFileSystemProvider(log))));
		return service;
	}

	type McpControl = { op: string; requestId?: string; name?: string; servers?: Record<string, unknown>; force?: readonly string[]; authoritative?: boolean };

	function createMcpSession(sessionUri: URI, onRequest: (control: McpControl) => unknown, extra: Record<string, unknown> = {}): unknown {
		return {
			sessionUri,
			sessionId: AgentSession.id(sessionUri),
			createdAt: 0,
			modifiedAt: 0,
			materialized: true,
			disposed: false,
			subagentTurnOwners: new Map(),
			completedSubagentToolCallIds: new Set(),
			pendingClientToolCalls: new Set(),
			pendingInputs: new Map(),
			storedTurns: [],
			storedSubagentTurns: new Map(),
			proc: {
				isRunning: true,
				nextRequestId: () => `request-${Math.random()}`,
				request: async (control: McpControl) => ({ type: 'serve:mcp', payload: onRequest(control) }),
				dispose: () => { },
			},
			...extra,
		};
	}

	test('model refresh coalesces concurrent requests and permits retry after failure', async () => {
		const agent = createAgent();
		let calls = 0;
		let release!: () => void;
		const pending = new Promise<void>(resolve => release = resolve);
		Reflect.set(agent, '_refreshModelCatalog', () => { calls++; return pending; });
		const first = agent.executeCommand('models.refresh');
		const second = agent.executeCommand('models.refresh');
		assert.strictEqual(calls, 1);
		release();
		await Promise.all([first, second]);
		Reflect.set(agent, '_refreshModelCatalog', async () => { throw new Error('offline'); });
		await assert.rejects(agent.executeCommand('models.refresh'), /offline/);
		Reflect.set(agent, '_refreshModelCatalog', async () => { calls++; });
		await agent.executeCommand('models.refresh');
		assert.strictEqual(calls, 2);
	});

	test('media config renders cached catalogs while both background refreshes are pending', async () => {
		const agent = createAgent();
		const pending = new DeferredPromise<readonly { value: string; label: string }[]>();
		const warmed: string[] = [];
		Reflect.set(agent, '_generativeCatalog', {
			peek: (property: string) => [{ value: `provider/${property}`, label: property }],
			get: (property: string) => { warmed.push(property); return pending.p; },
		});
		const config = await agent.resolveSessionConfig({ config: { videoModel: 'provider/videoModel' } });
		assert.deepStrictEqual({
			images: config.schema.properties.imageModel.enum,
			videos: config.schema.properties.videoModel.enum,
			labels: config.schema.properties.videoModel.enumLabels,
			selected: config.values.videoModel,
			warmed,
		}, {
			images: ['provider/imageModel'], videos: ['provider/videoModel'],
			labels: ['videoModel'], selected: 'provider/videoModel', warmed: ['imageModel', 'videoModel'],
		});
		await pending.complete([]);
	});

	test('media completions preserve the full local-filter catalog and propagate refresh errors', async () => {
		const agent = createAgent();
		const items = Array.from({ length: 205 }, (_, i) => ({ value: `provider/${i}`, label: `Model ${i}` }));
		const calls: Array<{ property: string; refresh: boolean | undefined }> = [];
		Reflect.set(agent, '_generativeCatalog', {
			get: async (property: string, refresh?: boolean) => {
				calls.push({ property, refresh });
				if (refresh) { throw new Error('offline'); }
				return items;
			},
		});
		assert.deepStrictEqual((await agent.sessionConfigCompletions({ property: 'videoModel' })).items, items);
		await assert.rejects(agent.sessionConfigCompletions({ property: 'videoModel', refresh: true }), /offline/);
		assert.deepStrictEqual(calls, [{ property: 'videoModel', refresh: undefined }, { property: 'videoModel', refresh: true }]);
	});

	test('pushes client-synced MCP servers to the session runtime and publishes them as customizations', async () => {
		const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-mcp-plugin-'));
		fs.writeFileSync(path.join(pluginDir, '.mcp.json'), JSON.stringify({
			mcpServers: {
				backboard: { type: 'http', url: 'https://backboard-docs.docsalot.dev/api/mcp' },
				playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
			},
		}));

		const fileService = makeFileService();
		const pluginManager = {
			syncCustomizations: async () => [{
				customization: { type: CustomizationType.Plugin, id: 'plugin-1', uri: URI.file(pluginDir).toString(), name: 'synced', enabled: true },
				pluginDir: URI.file(pluginDir),
			}],
		};
		const agent = createAgent({}, {}, {}, {}, pluginManager, fileService);

		const requests: Array<{ op: string; servers?: Record<string, unknown>; force?: readonly string[] }> = [];
		const sessionUri = AgentSession.uri('backboard', 'mcp-session');
		const session = createMcpSession(sessionUri, control => {
			requests.push(control);
			return {
				servers: Object.keys(control.servers ?? {}).map(name => ({
					name,
					status: control.servers?.[name] && (control.servers[name] as { disabled?: boolean }).disabled ? 'disabled' : 'connected',
					toolNames: [`mcp__${name}__tool`],
				})),
			};
		});
		const internals = agent as unknown as { _sessions: Map<string, unknown> };
		internals._sessions.set('mcp-session', session);

		const synced = await agent.setClientCustomizations(sessionUri, 'client-1', [
			{ type: CustomizationType.Plugin, id: 'plugin-1', uri: URI.file(pluginDir).toString(), name: 'synced', enabled: true } as never,
		]);

		assert.strictEqual(synced.length, 1);
		assert.strictEqual(requests.length, 1);
		assert.strictEqual(requests[0].op, 'setMcpServers');
		assert.deepStrictEqual(Object.keys(requests[0].servers ?? {}).sort(), ['backboard', 'playwright']);
		assert.strictEqual((requests[0].servers!['backboard'] as { url?: string }).url, 'https://backboard-docs.docsalot.dev/api/mcp');
		assert.strictEqual((requests[0].servers!['playwright'] as { command?: string }).command, 'npx');

		const customizations = await agent.getSessionCustomizations(sessionUri);
		assert.deepStrictEqual(customizations.map(c => c.name).sort(), ['backboard', 'playwright']);
		for (const customization of customizations) {
			assert.strictEqual(customization.type, CustomizationType.McpServer);
			assert.strictEqual((customization as { state: { kind: McpServerStatus } }).state.kind, McpServerStatus.Ready);
		}

		// The composer's per-server toggle disconnects a server for this session.
		const backboard = customizations.find(c => c.name === 'backboard')!;
		agent.setCustomizationEnabled(backboard.id, false);
		await (session as { mcpPush?: Promise<void> }).mcpPush;
		assert.strictEqual(requests.length, 2);
		assert.strictEqual((requests[1].servers!['backboard'] as { disabled?: boolean }).disabled, true);
		assert.strictEqual((requests[1].servers!['playwright'] as { disabled?: boolean }).disabled, undefined);

		const afterToggle = await agent.getSessionCustomizations(sessionUri);
		const disabledBackboard = afterToggle.find(c => c.name === 'backboard')!;
		assert.strictEqual(disabledBackboard.enabled, false);
		assert.strictEqual((disabledBackboard as { state: { kind: McpServerStatus } }).state.kind, McpServerStatus.Stopped);

		// Reconnecting forces a fresh handshake for that server only.
		agent.setCustomizationEnabled(backboard.id, true);
		await (session as { mcpPush?: Promise<void> }).mcpPush;
		assert.strictEqual(requests.length, 3);
		assert.deepStrictEqual(requests[2].force, ['backboard']);
		assert.strictEqual((requests[2].servers!['backboard'] as { disabled?: boolean }).disabled, undefined);
	});

	test('runtime-reported MCP servers are listed, signed in on enable, and dedupe client tools', async () => {
		const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-mcp-plugin-'));
		fs.writeFileSync(path.join(pluginDir, '.mcp.json'), JSON.stringify({
			mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } },
		}));
		const pluginManager = {
			syncCustomizations: async () => [{
				customization: { type: CustomizationType.Plugin, id: 'plugin-1', uri: URI.file(pluginDir).toString(), name: 'synced', enabled: true },
				pluginDir: URI.file(pluginDir),
			}],
		};
		const agent = createAgent({}, {}, {}, {}, pluginManager, makeFileService());
		const requests: McpControl[] = [];
		const sessionUri = AgentSession.uri('backboard', 'mcp-runtime-session');
		// `linear` comes from a project `.backboard/mcp.json`: the runtime runs it
		// although the IDE never pushed it.
		const session = createMcpSession(sessionUri, control => {
			requests.push(control);
			if (control.op === 'authenticateMcpServer') {
				return { servers: [{ name: 'docs', status: 'connected' }, { name: 'linear', status: 'connected', source: 'project' }] };
			}
			return { servers: [{ name: 'docs', status: 'needs_authentication', message: 'Sign in to docs' }, { name: 'linear', status: 'connected', source: 'project' }] };
		}, { mcpStatusEvents: true });
		(agent as unknown as { _sessions: Map<string, unknown> })._sessions.set('mcp-runtime-session', session);

		await agent.setClientCustomizations(sessionUri, 'client-1', [
			{ type: CustomizationType.Plugin, id: 'plugin-1', uri: URI.file(pluginDir).toString(), name: 'synced', enabled: true } as never,
		]);
		const listed = await agent.getSessionCustomizations(sessionUri);
		const summary = (customizations: readonly Customization[]) => customizations.map(c => {
			const state = (c as { state: { kind: McpServerStatus; error?: { errorType: string } } }).state;
			return [c.name, state.kind, state.error?.errorType];
		}).sort();
		assert.deepStrictEqual({ authoritative: requests[0].authoritative, listed: summary(listed) }, {
			authoritative: true,
			listed: [['docs', McpServerStatus.Error, MCP_AUTH_REQUIRED_ERROR_TYPE], ['linear', McpServerStatus.Ready, undefined]],
		});

		// A connected runtime server's IDE client-tool copies are dropped; the
		// copies of a server the runtime could not connect stay.
		Reflect.set(session as object, 'clientTools', {
			clientId: 'client-1',
			tools: [
				{ name: 'linear_search', _meta: { source: 'mcp', mcpServerLabel: 'linear' } },
				{ name: 'docs_search', _meta: { source: 'mcp', mcpServerLabel: 'docs' } },
				{ name: 'open_browser', _meta: { source: 'internal' } },
			],
		});
		const turnTools = (agent as unknown as { _clientToolsForTurn(session: unknown): readonly { name: string }[] })._clientToolsForTurn(session);
		assert.deepStrictEqual(turnTools.map(tool => tool.name), ['docs_search', 'open_browser']);

		// Enabling a server that waits for sign-in runs the runtime's sign-in.
		agent.setCustomizationEnabled(listed.find(c => c.name === 'docs')!.id, true);
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual(requests.map(r => r.op === 'authenticateMcpServer' ? `${r.op}:${r.name}` : r.op), ['setMcpServers', 'authenticateMcpServer:docs']);
		assert.deepStrictEqual(summary(await agent.getSessionCustomizations(sessionUri)), [['docs', McpServerStatus.Ready, undefined], ['linear', McpServerStatus.Ready, undefined]]);
	});

	test('does not push MCP servers before the IDE has synced its set', async () => {
		const agent = createAgent();
		const requests: McpControl[] = [];
		const sessionUri = AgentSession.uri('backboard', 'mcp-unsynced');
		const session = createMcpSession(sessionUri, control => { requests.push(control); return { servers: [] }; }, { mcpStatusEvents: true });
		(agent as unknown as { _sessions: Map<string, unknown> })._sessions.set('mcp-unsynced', session);
		await (agent as unknown as { _pushMcpServers(session: unknown): Promise<void> })._pushMcpServers(session);
		assert.deepStrictEqual(requests, []);
	});

	test('distinguishes successful no-match and partial searches from execution failure', () => {
		assert.strictEqual(cliTsToolExecutionFailed({ type: 'tool:result', execution: { exitCode: 1, outcome: 'no_match' } }), false);
		assert.strictEqual(cliTsToolExecutionFailed({ type: 'tool:result', execution: { outcome: 'partial' } }), false);
		assert.strictEqual(cliTsToolExecutionFailed({ type: 'tool:result', execution: { exitCode: 2 } }), true);
		assert.strictEqual(cliTsToolExecutionFailed({ type: 'tool:result', execution: { cancelled: true } }), true);
	});

	test('rewind keeps stable turn ids, persists editor recovery, and seeds only retained provider history', async () => {
		const agent = createAgent();
		const requests: Array<{ op: string; transactionId?: string; turnIds?: string[] }> = [];
		type TestSession = {
			storedTurns: Array<{ id: string; prompt: string; response: string }>;
			threadId?: string;
			forkContext?: string;
			proc?: { dispose(): void };
			rewind?: { activeCount: number; editorRefresh?: { transactionId: string; buffers: readonly { path: string; content: string }[] } };
		};
		const internals = agent as unknown as {
			_sessions: Map<string, TestSession>;
			_writeStore(): void;
			_archiveRewindBranch(): void;
			_resolveRgDir(): Promise<string | undefined>;
			_ensureProcess(session: TestSession): unknown;
		};
		internals._writeStore = () => {};
		internals._archiveRewindBranch = () => {};
		internals._resolveRgDir = async () => undefined;
		let disposed = 0;
		const proc = {
			nextRequestId: () => 'request-id',
			notify: () => {},
			dispose: () => disposed++,
			request: async (request: typeof requests[number]) => {
				requests.push(request);
				return { payload: { transactionId: request.transactionId, status: request.op === 'prepareRewind' ? 'prepared' : request.op === 'recoverRewind' ? 'recovered' : 'committed',
					paths: ['/workspace/mario.html'], backupId: 'backup-id', buffers: request.op === 'recoverRewind' ? [{ path: '/workspace/mario.html', content: 'unsaved' }] : [] } };
			},
		};
		internals._ensureProcess = session => session.proc = proc;
		const created = await agent.createSession({});
		const session = internals._sessions.get(AgentSession.id(created.session))!;
		session.storedTurns.push({ id: 'one', prompt: 'KEEP', response: 'retained' }, { id: 'two', prompt: 'DISCARD', response: 'discarded' });
		session.threadId = 'old-provider-thread';
		const prepared = await agent.rewindSession(created.session, { operation: 'prepare', retainedTurnId: 'one' });
		const committed = await agent.rewindSession(created.session, { operation: 'commit', transactionId: prepared.transactionId, buffers: [{ path: '/workspace/mario.html', content: 'unsaved' }] });
		assert.deepStrictEqual({ ids: requests[0].turnIds, activeCount: committed.activeCount, oldThread: session.threadId, refresh: session.rewind?.editorRefresh?.transactionId },
			{ ids: ['two'], activeCount: 1, oldThread: undefined, refresh: prepared.transactionId });
		assert.ok(session.forkContext?.includes('KEEP') && !session.forkContext.includes('DISCARD'));
		assert.strictEqual(disposed, 1);
		assert.deepStrictEqual(await agent.rewindSession(created.session, { operation: 'resume' }), committed);
		await assert.rejects(agent.truncateSession(created.session, 'one'), /restoration is still pending/);
		await agent.rewindSession(created.session, { operation: 'acknowledge', transactionId: prepared.transactionId });
		const recovered = await agent.rewindSession(created.session, { operation: 'recover' });
		assert.deepStrictEqual({ count: recovered.activeCount, buffers: recovered.buffers }, { count: 2, buffers: [{ path: '/workspace/mario.html', content: 'unsaved' }] });
		await agent.rewindSession(created.session, { operation: 'acknowledge', transactionId: prepared.transactionId });
		assert.strictEqual(session.rewind?.editorRefresh, undefined);
	});

	test('recognizes renewable and missing ChatGPT subscription logins', () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-subscription-login-'));
		const previousAuthOverride = process.env['BACKBOARD_CHATGPT_SUBSCRIPTION_AUTH_FILE'];
		delete process.env['BACKBOARD_CHATGPT_SUBSCRIPTION_AUTH_FILE'];
		try {
			const authFile = path.join(tempRoot, 'subscription-auth.json');
			const jwt = (exp: number) => [
				Buffer.from('{}').toString('base64url'),
				Buffer.from(JSON.stringify({ exp })).toString('base64url'),
				'signature',
			].join('.');
			fs.mkdirSync(path.join(tempRoot, '.backboard'), { recursive: true });
			fs.writeFileSync(path.join(tempRoot, '.backboard', 'config.json'), JSON.stringify({ chatgptSubscriptionAuthFile: authFile }));
			fs.writeFileSync(authFile, JSON.stringify({ tokens: { access_token: jwt(1), refresh_token: 'renewable' } }));

			assert.strictEqual(hasUsableChatGptSubscriptionLogin(tempRoot, 2_000), true);
			fs.writeFileSync(authFile, JSON.stringify({ tokens: { access_token: jwt(1) } }));
			assert.strictEqual(hasUsableChatGptSubscriptionLogin(tempRoot, 2_000), false);
			assert.strictEqual(isChatGptSubscriptionModel('openai-subscription/gpt-5.6-sol'), true);
			assert.strictEqual(isChatGptSubscriptionModel('openai/gpt-5.6-sol'), false);
		} finally {
			if (previousAuthOverride === undefined) {
				delete process.env['BACKBOARD_CHATGPT_SUBSCRIPTION_AUTH_FILE'];
			} else {
				process.env['BACKBOARD_CHATGPT_SUBSCRIPTION_AUTH_FILE'] = previousAuthOverride;
			}
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('publishes ChatGPT connection state without changing other model metadata', () => {
		const subscription = { provider: 'backboard' as const, id: 'openai-subscription/gpt-5.6-sol', name: 'GPT-5.6 Sol', supportsVision: true };
		const api = { provider: 'backboard' as const, id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', supportsVision: true };

		const connected = withChatGptSubscriptionConnectionState([subscription, api], true);

		assert.strictEqual(connected[0]._meta?.chatGptSubscriptionConnected, true);
		assert.strictEqual(connected[1], api);
		assert.strictEqual(withChatGptSubscriptionConnectionState(connected, false)[0]._meta?.chatGptSubscriptionConnected, false);
	});

	test('publishes Claude connection state without changing other model metadata', () => {
		const subscription = { provider: 'backboard' as const, id: 'anthropic-subscription/sonnet', name: 'Claude Sonnet', supportsVision: true };
		const api = { provider: 'backboard' as const, id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', supportsVision: true };

		const connected = withClaudeSubscriptionConnectionState([subscription, api], true);

		assert.strictEqual(isClaudeSubscriptionModel(subscription.id), true);
		assert.strictEqual(isClaudeSubscriptionModel(api.id), false);
		assert.strictEqual(connected[0]._meta?.claudeSubscriptionConnected, true);
		assert.strictEqual(connected[1], api);
		assert.strictEqual(withClaudeSubscriptionConnectionState(connected, false)[0]._meta?.claudeSubscriptionConnected, false);
	});

	test('hands subscription threads off only when the selected provider changes', () => {
		assert.strictEqual(requiresProviderThreadHandoff(
			'claude_sub_thread-1',
			'anthropic-subscription/sonnet',
			'anthropic-subscription/opus',
		), false);
		assert.strictEqual(requiresProviderThreadHandoff(
			'claude_sub_thread-1',
			'anthropic-subscription/sonnet',
			'anthropic/claude-sonnet-5',
		), true);
		assert.strictEqual(requiresProviderThreadHandoff(
			'sub_thread-2',
			'openai-subscription/gpt-5.6-sol',
			'google/gemini-3-pro',
		), true);
		assert.strictEqual(requiresProviderThreadHandoff(
			'claude_sub_restored',
			undefined,
			'openai-subscription/gpt-5.6-sol',
		), true);
		assert.strictEqual(requiresProviderThreadHandoff(
			undefined,
			'anthropic-subscription/sonnet',
			'openai/gpt-5.6',
		), false);
	});

	test('changing providers preserves the IDE transcript and releases the native thread', async () => {
		const agent = createAgent();
		const internals = agent as unknown as {
			_sessions: Map<string, {
				model?: { id: string };
				threadId?: string;
				forkContext?: string;
				providerHandoffContext?: string;
				storedTurns: Array<{ prompt: string; response: string }>;
				sendQueue?: Promise<void>;
				proc?: { isRunning: boolean; dispose(): void; notify(value: unknown): void; nextRequestId(): string; request(value: unknown): Promise<unknown> };
			}>;
			_writeStore(): void;
		};
		let storeWrites = 0;
		internals._writeStore = () => storeWrites++;
		const created = await agent.createSession({ model: { id: 'anthropic-subscription/sonnet' } });
		const session = internals._sessions.get(AgentSession.id(created.session));
		assert.ok(session);
		session.threadId = 'claude_sub_native-thread';
		session.storedTurns.push({ prompt: 'Remember marker ORCHID.', response: 'I will remember ORCHID.' });
		let disposed = 0;
		let notified = 0;
		session.proc = {
			isRunning: true,
			dispose: () => disposed++,
			notify: () => notified++,
			nextRequestId: () => 'idle',
			request: async () => ({}),
		};

		await agent.changeModel(created.session, { id: 'openai/gpt-5.6' });
		await session.sendQueue;

		assert.strictEqual(session.model?.id, 'openai/gpt-5.6');
		assert.strictEqual(session.threadId, undefined);
		assert.strictEqual(session.proc, undefined);
		assert.strictEqual(disposed, 1);
		assert.strictEqual(notified, 0);
		assert.strictEqual(storeWrites, 2);
		assert.strictEqual(session.forkContext, undefined);
		assert.match(session.providerHandoffContext ?? '', /ORCHID/);
		assert.match(session.providerHandoffContext ?? '', /changed model providers/);
	});

	test('bounds tool records in a conversation handoff instead of replaying captured output', () => {
		const context = buildConversationHandoffContext([{
			prompt: 'run the build',
			response: 'done',
			parts: [{
				kind: 'tool',
				id: 'call-1',
				name: 'execute',
				input: { command: 'npm run build', secretPadding: 'x'.repeat(50_000) },
				result: 'y'.repeat(50_000),
				inputSummary: 'npm run build',
				terminalCommand: 'npm run build',
				terminalOutput: { text: 'z'.repeat(80_000), exitCode: 0 },
			}],
		}], 'Test handoff.');

		assert.ok(context.length < 6_000, `handoff was ${context.length} characters`);
		assert.ok(!context.includes('secretPadding'));
		assert.match(context, /npm run build/);
		assert.match(context, /characters omitted/);
		assert.match(context, /"exitCode":0/);
	});

	test('waits for runtime workers and coalesces model selections before applying one', async () => {
		const agent = createAgent();
		const internals = agent as unknown as {
			_sessions: Map<string, { threadId?: string; sendQueue?: Promise<void>; proc?: unknown }>;
			_writeStore(): void;
			_sendMessage(session: unknown): Promise<void>;
		};
		internals._writeStore = () => {};
		let sent = false;
		internals._sendMessage = async () => { sent = true; };
		const created = await agent.createSession({ model: { id: 'openai-key/gpt-4.1' } });
		const session = internals._sessions.get(AgentSession.id(created.session))!;
		session.threadId = 'byok_thread';
		let release!: () => void;
		const idle = new Promise<void>(resolve => { release = resolve; });
		let entered!: () => void;
		const waiting = new Promise<void>(resolve => { entered = resolve; });
		const controls: Array<{ op: string; model?: string; source?: string }> = [];
		session.proc = { isRunning: true, nextRequestId: () => 'change', dispose: () => {},
			request: async (control: { op: string; model?: string; source?: string }) => {
				controls.push(control);
				if (control.op === 'waitForIdle') { entered(); await idle; }
				return { payload: { op: control.op } };
			},
		};
		await agent.changeModel(created.session, { id: 'google-key/gemini-2.5-flash' });
		await waiting;
		await agent.changeModel(created.session, { id: 'xai-key/grok-4.6' });
		const submission = agent.sendMessage(created.session, 'queued');
		assert.deepStrictEqual({ controls: controls.map(control => control.op), sent }, { controls: ['waitForIdle'], sent: false });
		release();
		await submission;
		assert.strictEqual(sent, true);
		assert.deepStrictEqual(controls.map(({ op, model, source }) => ({ op, model, source })), [
			{ op: 'waitForIdle', model: undefined, source: undefined },
			{ op: 'setModel', model: 'xai/grok-4.6', source: 'byok' },
		]);
	});

	test('fails fast with an actionable reconnect when Claude login expires', async () => {
		let probes = 0;
		await assert.rejects(
			assertUsableClaudeSubscriptionLogin(async () => {
				probes++;
				return false;
			}),
			/choose Claude, then select Connect or Reconnect Claude/,
		);
		await assertUsableClaudeSubscriptionLogin(async () => {
			probes++;
			return true;
		});
		assert.strictEqual(probes, 2);
	});

	test('does not let a stale Claude probe undo a newer connection', async () => {
		const agent = createAgent();
		const internals = agent as unknown as {
			_refreshClaudeSubscriptionConnectionState(probe: () => Promise<boolean>): Promise<void>;
			_setClaudeSubscriptionConnectionState(connected: boolean): void;
			_claudeSubscriptionConnected: boolean;
		};
		let resolve!: (connected: boolean) => void;
		const refresh = internals._refreshClaudeSubscriptionConnectionState(() => new Promise<boolean>(complete => { resolve = complete; }));
		internals._setClaudeSubscriptionConnectionState(true);
		resolve(false);
		await refresh;
		assert.strictEqual(internals._claudeSubscriptionConnected, true);
	});

	test('reports whether Claude setup needs OAuth', async () => {
		const agent = createAgent();
		for (const connected of [true, false]) {
			Reflect.set(agent, '_refreshClaudeSubscriptionConnectionState', async () => { Reflect.set(agent, '_claudeSubscriptionConnected', connected); });
			assert.deepStrictEqual(await agent.executeCommand('claudeSubscription.check'), { message: '', requiresSignIn: !connected });
		}
	});

	test('refuses to start interactive Claude OAuth through the stdin-less agent command', async () => {
		await assert.rejects(
			createAgent().executeCommand('claudeSubscription.login'),
			/requires an interactive terminal/,
		);
	});

	test('treats every key-billed vendor as one handoff family', () => {
		assert.deepStrictEqual(
			[
				requiresProviderThreadHandoff('byok_abc', undefined, 'openai/gpt-5.5'),
				requiresProviderThreadHandoff('byok_abc', 'openai-key/gpt-5.5', 'anthropic-key/claude-opus-5'),
				requiresProviderThreadHandoff('thread_bb', 'openai/gpt-5.5', 'openai-key/gpt-5.5'),
				requiresProviderThreadHandoff('thread_bb', undefined, 'anthropic-key/claude-opus-5'),
				requiresProviderThreadHandoff('thread_bb', 'openai/gpt-5.5', 'openai/gpt-5.6'),
			],
			[true, false, true, true, false],
		);
	});

	test('publishes key-billed models only after a key is validated and activated', async () => {
		const agent = createAgent();
		const validated: string[] = [];
		const internals = agent as unknown as {
			_validateProviderKey(provider: string, key: string): Promise<unknown>;
			_pushCredentials(): Promise<{ acknowledged: number; terminated: number; unconfirmed: number; total: number }>;
			_persistModelsCache(): void;
		};
		internals._validateProviderKey = async (provider, key) => {
			validated.push(`${provider}:${key}`);
			return { ok: true, models: [{ provider, name: 'gpt-5.5', model_type: 'llm' }] };
		};
		internals._pushCredentials = async () => ({ acknowledged: 0, terminated: 0, unconfirmed: 0, total: 0 });
		internals._persistModelsCache = () => { };
		const keyRow = () => agent.models.get().find(model => model.id === 'openai-key/gpt-5.5');

		await assert.rejects(agent.executeCommand('providerKeys.validate', { provider: 'openai', key: '  ' }), /Enter an? OpenAI API key/);
		await assert.rejects(agent.executeCommand('providerKeys.validate', { provider: 'unsupported', key: 'test' }), /not supported/);

		const validation = await agent.executeCommand('providerKeys.validate', { provider: 'openai', key: 'sk-test-key' });
		const activation = await agent.executeCommand('providerKeys.set', { provider: 'openai', key: 'sk-test-key' });
		const afterActivation = keyRow();
		await agent.executeCommand('providerKeys.remove', { provider: 'openai' });
		const afterRemoval = keyRow();
		const status = await agent.executeCommand('providerKeys.status');

		assert.deepStrictEqual({
			validation: validation.data,
			vendorCalls: validated,
			activation: activation.data,
			afterActivation: { label: afterActivation?._meta?.upstreamProviderLabel, configured: afterActivation?._meta?.byokKeyConfigured },
			afterRemoval: { listed: afterRemoval !== undefined, configured: afterRemoval?._meta?.byokKeyConfigured },
			status: status.data,
		}, {
			validation: { ok: true, modelCount: 1 },
			// Activation reuses the validated catalog instead of calling the vendor again.
			vendorCalls: ['openai:sk-test-key'],
			activation: { connected: true, revision: 1, acknowledged: 0, terminated: 0, running: 0 },
			afterActivation: { label: 'OpenAI API Key', configured: true },
			// The row stays listed so a pinned session keeps its selection, but it is unavailable.
			afterRemoval: { listed: true, configured: false },
			status: { providers: { openai: { held: false, discovered: true }, anthropic: { held: false, discovered: false }, google: { held: false, discovered: false }, openrouter: { held: false, discovered: false }, xai: { held: false, discovered: false } }, revision: 2 },
		});
	});

	test('sends the billing route with every turn and refuses a key-billed model without a key', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-cli-ts-byok-'));
		try {
			const agent = createAgent({}, {}, {}, { getSessionConfigValues: () => ({ isolation: 'folder' }) });
			const progress: AgentSignal[] = [];
			store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
			const submits: Array<{ model?: string; source?: string }> = [];
			const internals = agent as unknown as {
				_storePath(): string;
				_materialize(session: { materialized: boolean }): Promise<void>;
				_resolveRgDir(): Promise<string | undefined>;
				_refreshModelsOnce(): void;
				_ensureProcess(session: unknown): unknown;
				_validateProviderKey(provider: string, key: string): Promise<unknown>;
				_pushCredentials(): Promise<{ acknowledged: number; terminated: number; unconfirmed: number; total: number }>;
				_persistModelsCache(): void;
			};
			internals._storePath = () => path.join(tempRoot, 'sessions.json');
			internals._materialize = async session => { session.materialized = true; };
			internals._resolveRgDir = async () => undefined;
			internals._refreshModelsOnce = () => { };
			internals._validateProviderKey = async provider => ({ ok: true, models: [{ provider, name: 'gpt-5.5', model_type: 'llm' }] });
			internals._pushCredentials = async () => ({ acknowledged: 0, terminated: 0, unconfirmed: 0, total: 0 });
			internals._persistModelsCache = () => { };
			internals._ensureProcess = () => ({
				isRunning: true,
				start: () => { },
				nextRequestId: () => 'fixture-request',
				request: async (request: { op: string; model?: string; source?: string }) => {
					if (request.op === 'submit') {
						submits.push({ model: request.model, source: request.source });
					}
					return { payload: { status: 'completed' } };
				},
				notify: () => { },
				dispose: () => { },
			});
			const sessionUri = AgentSession.uri('backboard', 'byok-route');
			await agent.createSession({ session: sessionUri, workingDirectory: URI.file(tempRoot), model: { id: 'openai-key/gpt-5.5' } });

			await agent.sendMessage(sessionUri, 'first');
			const errors = failureNotes(progress);

			await agent.executeCommand('providerKeys.set', { provider: 'openai', key: 'sk-test-key' });
			await agent.sendMessage(sessionUri, 'second');
			await agent.changeModel(sessionUri, { id: 'anthropic/claude-opus-5' });
			await agent.sendMessage(sessionUri, 'third');

			assert.deepStrictEqual({ errors, submits }, {
				errors: ["_This response couldn't start: No OpenAI API key is connected. Add one under API Keys to use this model._"],
				submits: [
					{ model: 'openai/gpt-5.5', source: 'byok' },
					{ model: 'anthropic/claude-opus-5', source: 'backboard' },
				],
			});
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('a replacement key with a narrower catalog keeps the old row listed but unavailable and blocks sends', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-cli-ts-narrow-key-'));
		try {
			const agent = createAgent({}, {}, {}, { getSessionConfigValues: () => ({ isolation: 'folder' }) });
			const progress: AgentSignal[] = [];
			store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
			let catalog = ['gpt-5.5', 'gpt-5-mini'];
			const submits: string[] = [];
			const internals = agent as unknown as {
				_storePath(): string;
				_materialize(session: { materialized: boolean }): Promise<void>;
				_resolveRgDir(): Promise<string | undefined>;
				_refreshModelsOnce(): void;
				_ensureProcess(session: unknown): unknown;
				_validateProviderKey(provider: string, key: string): Promise<unknown>;
				_pushCredentials(): Promise<{ acknowledged: number; terminated: number; unconfirmed: number; total: number }>;
				_persistModelsCache(): void;
			};
			internals._storePath = () => path.join(tempRoot, 'sessions.json');
			internals._materialize = async session => { session.materialized = true; };
			internals._resolveRgDir = async () => undefined;
			internals._refreshModelsOnce = () => { };
			internals._validateProviderKey = async provider => ({ ok: true, models: catalog.map(name => ({ provider, name, model_type: 'llm' })) });
			internals._pushCredentials = async () => ({ acknowledged: 0, terminated: 0, unconfirmed: 0, total: 0 });
			internals._persistModelsCache = () => { };
			internals._ensureProcess = () => ({
				isRunning: true,
				start: () => { },
				nextRequestId: () => 'fixture-request',
				request: async (request: { op: string; model?: string }) => {
					if (request.op === 'submit') {
						submits.push(request.model ?? '');
					}
					return { payload: { status: 'completed' } };
				},
				notify: () => { },
				dispose: () => { },
			});

			await agent.executeCommand('providerKeys.validate', { provider: 'openai', key: 'sk-first-key' });
			await agent.executeCommand('providerKeys.set', { provider: 'openai', key: 'sk-first-key' });
			catalog = ['gpt-5-mini'];
			await agent.executeCommand('providerKeys.validate', { provider: 'openai', key: 'sk-second-key' });
			await agent.executeCommand('providerKeys.set', { provider: 'openai', key: 'sk-second-key' });
			const rows = agent.models.get()
				.filter(model => ['openai-key/gpt-5.5', 'openai-key/gpt-5-mini'].includes(model.id))
				.map(model => [model.id, model._meta?.byokKeyConfigured, model._meta?.byokModelAvailable])
				.sort((left, right) => String(left[0]).localeCompare(String(right[0])));

			const sessionUri = AgentSession.uri('backboard', 'narrow-key');
			await agent.createSession({ session: sessionUri, workingDirectory: URI.file(tempRoot), model: { id: 'openai-key/gpt-5.5' } });
			await agent.sendMessage(sessionUri, 'hello');
			const errors = failureNotes(progress);

			assert.deepStrictEqual({ rows, submits, errors }, {
				// The row the new key cannot reach stays listed, so the pinned
				// selection stays visible, but it is flagged and refused on send.
				rows: [['openai-key/gpt-5-mini', true, true], ['openai-key/gpt-5.5', true, false]],
				submits: [],
				errors: ["_This response couldn't start: gpt-5.5 is not available with the connected OpenAI API key. Pick another OpenAI API Key model or replace the key._"],
			});
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('refuses key changes from a superseded generation and accepts equal or newer ones', async () => {
		const agent = createAgent();
		const internals = agent as unknown as {
			_validateProviderKey(provider: string, key: string): Promise<unknown>;
			_pushCredentials(): Promise<{ acknowledged: number; terminated: number; unconfirmed: number; total: number }>;
			_persistModelsCache(): void;
		};
		internals._validateProviderKey = async provider => ({ ok: true, models: [{ provider, name: 'gpt-5.5', model_type: 'llm' }] });
		internals._pushCredentials = async () => ({ acknowledged: 0, terminated: 0, unconfirmed: 0, total: 0 });
		internals._persistModelsCache = () => { };
		const held = async () => ((await agent.executeCommand('providerKeys.status')).data as { providers: Record<string, { held: boolean }> }).providers['openai'].held;

		await agent.executeCommand('providerKeys.set', { provider: 'openai', key: 'sk-new-key', generation: 2 });
		const staleSet = await agent.executeCommand('providerKeys.set', { provider: 'openai', key: 'sk-old-key', generation: 1 }).catch(error => error);
		const staleRemove = await agent.executeCommand('providerKeys.remove', { provider: 'openai', generation: 1 }).catch(error => error);
		const heldAfterStale = await held();
		await agent.executeCommand('providerKeys.set', { provider: 'openai', key: 'sk-new-key', generation: 2 });
		await agent.executeCommand('providerKeys.remove', { provider: 'openai', generation: 3 });

		assert.deepStrictEqual({
			staleSet: staleSet instanceof Error ? staleSet.message : 'accepted',
			staleRemove: staleRemove instanceof Error ? staleRemove.message : 'accepted',
			heldAfterStale,
			heldAfterRemoval: await held(),
		}, {
			staleSet: 'This OpenAI key change was superseded by a newer one.',
			staleRemove: 'This OpenAI key change was superseded by a newer one.',
			heldAfterStale: true,
			heldAfterRemoval: false,
		});
	});

	test('removal terminates a runtime that never acknowledges the credential change and reports it', async () => {
		const agent = createAgent();
		const terminations: string[] = [];
		let running = true;
		let pushes = 0;
		const proc = {
			get isRunning() { return running; },
			get credentialSnapshotWritten() { return running; },
			nextRequestId: () => 'r',
			request: (control: { op: string }) => {
				// The first push (activation) is applied; the second (removal) is never answered.
				if (control.op === 'setCredentials' && ++pushes === 2) {
					return new Promise(() => { });
				}
				return Promise.resolve({ payload: { op: control.op } });
			},
			terminate: (reason: string) => {
				terminations.push(reason);
				running = false;
			},
			whenExited: async () => { },
			dispose: () => { },
		};
		const internals = agent as unknown as {
			_sessions: Map<string, { proc: unknown }>;
			_credentialAckTimeoutMs: number;
			_validateProviderKey(provider: string, key: string): Promise<unknown>;
			_persistModelsCache(): void;
		};
		internals._credentialAckTimeoutMs = 20;
		internals._validateProviderKey = async provider => ({ ok: true, models: [{ provider, name: 'gpt-5.5', model_type: 'llm' }] });
		internals._persistModelsCache = () => { };
		internals._sessions.set('wedged', { proc });

		await agent.executeCommand('providerKeys.validate', { provider: 'openai', key: 'sk-test-key' });
		const activation = await agent.executeCommand('providerKeys.set', { provider: 'openai', key: 'sk-test-key' });
		const removal = await agent.executeCommand('providerKeys.remove', { provider: 'openai' });
		const status = await agent.executeCommand('providerKeys.status');

		assert.deepStrictEqual({
			activation: activation.data,
			removal: removal.data,
			terminations,
			held: (status.data as { providers: Record<string, { held: boolean }> }).providers['openai'].held,
		}, {
			activation: { connected: true, revision: 1, acknowledged: 1, terminated: 0, running: 1 },
			// The wedged runtime was ended instead of being left with the revoked key.
			removal: { revision: 2, acknowledged: 0, terminated: 1, running: 1 },
			terminations: ['Runtime restarted after a credential change.'],
			held: false,
		});
	});

	test('a Backboard-route turn fails closed when the runtime cannot honour host-managed keys', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-cli-ts-old-runtime-'));
		try {
			const agent = createAgent({}, {}, {}, { getSessionConfigValues: () => ({ isolation: 'folder' }) });
			const progress: AgentSignal[] = [];
			store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
			const internals = agent as unknown as {
				_storePath(): string;
				_materialize(session: { materialized: boolean }): Promise<void>;
				_resolveRgDir(): Promise<string | undefined>;
				_refreshModelsOnce(): void;
				_ensureProcess(session: unknown): unknown;
			};
			internals._storePath = () => path.join(tempRoot, 'sessions.json');
			internals._materialize = async session => { session.materialized = true; };
			internals._resolveRgDir = async () => undefined;
			internals._refreshModelsOnce = () => { };
			internals._ensureProcess = () => ({
				isRunning: true,
				start: () => { },
				nextRequestId: () => 'fixture-request',
				// The process gate rejects every request to a runtime without the capability.
				request: async () => { throw new Error('The bundled Backboard runtime does not support API keys. Update Backboard.'); },
				notify: () => { },
				dispose: () => { },
			});
			const sessionUri = AgentSession.uri('backboard', 'old-runtime');
			await agent.createSession({ session: sessionUri, workingDirectory: URI.file(tempRoot), model: { id: 'anthropic/claude-opus-5' } });

			await agent.sendMessage(sessionUri, 'hello');

			const errors = failureNotes(progress);
			assert.deepStrictEqual(errors, ["_This response couldn't start: The bundled Backboard runtime does not support API keys. Update Backboard._"]);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('usage event forwards the context measurement via ChatUsage _meta', () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'usage-live');
		const internals = agent as unknown as {
			_handleMappedAgentEvent(
				session: { sessionUri: typeof sessionUri },
				event: { type: string; usage?: { inputTokens?: number; outputTokens?: number; contextTokens?: number; contextLimit?: number; model?: string } },
				turn: { turnId: string; toolInputs: Map<string, { name: string; input: unknown }> },
			): void;
		};
		const turn = { turnId: 'turn-usage', toolInputs: new Map<string, { name: string; input: unknown }>() };

		internals._handleMappedAgentEvent({ sessionUri }, {
			type: 'usage',
			usage: { inputTokens: 1200, outputTokens: 300, contextTokens: 45_000, contextLimit: 200_000, model: 'anthropic/claude-sonnet-5' },
		}, turn);
		internals._handleMappedAgentEvent({ sessionUri }, {
			type: 'usage',
			usage: { inputTokens: 10, outputTokens: 2 },
		}, turn);

		const usages = progress
			.filter(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatUsage)
			.map(signal => signal.kind === 'action' ? signal.action : undefined);
		assert.strictEqual(usages.length, 2);
		assert.deepStrictEqual(usages[0], {
			type: ActionType.ChatUsage,
			turnId: 'turn-usage',
			usage: {
				inputTokens: 1200,
				outputTokens: 300,
				model: 'anthropic/claude-sonnet-5',
				_meta: { contextTokens: 45_000, contextLimit: 200_000 },
			},
		});
		// No context measurement → no `_meta` key at all.
		assert.deepStrictEqual(usages[1], {
			type: ActionType.ChatUsage,
			turnId: 'turn-usage',
			usage: { inputTokens: 10, outputTokens: 2, model: undefined },
		});
	});

	test('checkpoint cleanup uses a supplied repository after an archived worktree is gone', async () => {
		const sessionUri = AgentSession.uri('backboard', 'archived-checkpoints');
		const missingWorkingDirectory = URI.file('/missing/backboard-worktree');
		const repositoryRoot = URI.file('/repository/that-still-exists');
		const baseRef = 'refs/agents/archived-checkpoints/checkpoints/turn/0';
		const turnRef = 'refs/agents/archived-checkpoints/checkpoints/turn/1';
		let repositoryLookups = 0;
		const deletions: Array<{ repository: string; refs: string[] }> = [];
		const checkpointService = store.add(new AgentHostCheckpointService(
			{
				onWillDeleteSessionData: () => ({ dispose: () => { } }),
				tryOpenDatabase: async () => ({
					object: {
						getMetadata: async (key: string) => key === 'checkpoint.workingDir'
							? missingWorkingDirectory.toString()
							: key === 'checkpoint.baseRef' ? baseRef : undefined,
						getAllCheckpointRefs: async () => [baseRef, turnRef, turnRef],
					},
					dispose: () => { },
				}),
			} as never,
			{
				getRepositoryRoot: async () => {
					repositoryLookups++;
					return undefined;
				},
				deleteRefs: async (repository: URI, refs: string[]) => {
					deletions.push({ repository: repository.toString(), refs });
				},
			} as never,
			new NullLogService(),
		));

		await checkpointService.disposeSessionData(sessionUri, repositoryRoot);

		assert.strictEqual(repositoryLookups, 0);
		assert.deepStrictEqual(deletions, [{ repository: repositoryRoot.toString(), refs: [baseRef, turnRef] }]);
	});

	test('new sessions defer their workspace baseline until the final folder is materialized', async () => {
		const captures: Array<{ session: string; workingDirectory: string | undefined }> = [];
		const agent = createAgent({
			captureBaseline: async (session: URI, workingDirectory: URI | undefined) => {
				captures.push({ session: session.toString(), workingDirectory: workingDirectory?.toString() });
			},
		});
		const internals = agent as unknown as {
			_prewarm(session: unknown): Promise<void>;
			_materialize(session: unknown, prompt: string, config?: Record<string, unknown>): Promise<void>;
			_sessions: Map<string, unknown>;
			_writeStore(): void;
		};
		internals._prewarm = async () => { };
		internals._writeStore = () => { };

		const workingDirectory = URI.file('/workspace/already-dirty');
		const created = await agent.createSession({ workingDirectory });
		assert.deepStrictEqual(captures, []);
		const session = internals._sessions.get(AgentSession.id(created.session));
		assert.ok(session);
		// No explicit isolation: ordinary Backboard sessions must stay in the
		// selected folder instead of creating an adjacent project worktree.
		await internals._materialize(session, 'Make the requested change');
		await internals._materialize(session, 'A repeated call is idempotent');
		assert.deepStrictEqual(captures, [{
			session: created.session.toString(),
			workingDirectory: workingDirectory.toString(),
		}]);
	});

	test('the first provisional folder session prewarms the model catalog before send', async () => {
		const agent = createAgent();
		let prewarms = 0;
		const internals = agent as unknown as {
			_prewarm(session: unknown): Promise<void>;
		};
		internals._prewarm = async () => {
			prewarms++;
		};

		const created = await agent.createSession({
			workingDirectory: URI.file('/workspace/provisional-folder'),
			config: { isolation: 'folder' },
		});

		assert.strictEqual(created.provisional, true);
		assert.strictEqual(prewarms, 1);
	});

	test('worktree materialization creates one isolated checkout before capturing the baseline', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-cli-ts-worktree-'));
		try {
			const repositoryRoot = URI.file(path.join(tempRoot, 'primary-repo'));
			const sourceRepositoryRoot = URI.file(path.join(tempRoot, 'linked-worktree'));
			const sourceWorkingDirectory = URI.file(path.join(sourceRepositoryRoot.fsPath, 'packages', 'desktop'));
			fs.mkdirSync(repositoryRoot.fsPath, { recursive: true });
			fs.mkdirSync(sourceWorkingDirectory.fsPath, { recursive: true });
			const added: Array<{ repositoryRoot: string; worktree: string; branchName: string; baseBranch: string }> = [];
			const captures: string[] = [];
			const metadata = new Map<string, string>();
			const gitService = {
				getRepositoryRoot: async () => sourceRepositoryRoot,
				getWorktreeRoots: async () => [repositoryRoot, sourceRepositoryRoot],
				getCurrentBranch: async () => 'feature/current',
				getDefaultBranch: async () => 'origin/main',
				branchExists: async () => false,
				addWorktree: async (repo: URI, worktree: URI, branchName: string, baseBranch: string) => {
					added.push({ repositoryRoot: repo.toString(), worktree: worktree.toString(), branchName, baseBranch });
					fs.mkdirSync(path.join(worktree.fsPath, 'packages', 'desktop'), { recursive: true });
				},
			};
			const checkpointService = {
				captureBaseline: async (_session: URI, workingDirectory: URI | undefined) => {
					captures.push(workingDirectory?.toString() ?? '');
				},
			};
			const sessionDataService = {
				openDatabase: () => ({
					object: {
						setMetadata: async (key: string, value: string) => {
							metadata.set(key, value);
						},
					},
					dispose: () => { },
				}),
			};
			const agent = createAgent(checkpointService, sessionDataService, gitService);
			const sessionUri = AgentSession.uri('backboard', 'worktree-session-1234');
			const internals = agent as unknown as {
				_materialize(session: unknown, prompt: string, config?: Record<string, unknown>): Promise<void>;
				_sessions: Map<string, { workingDirectory?: URI; sourceWorkingDirectory?: URI; materialized: boolean }>;
				_readStore(): unknown[];
				_writeStore(): void;
			};
			internals._readStore = () => [];
			internals._writeStore = () => { };
			const materializedEvents: Array<{ workingDirectory?: string; project?: string }> = [];
			store.add(agent.onDidMaterializeSession(event => materializedEvents.push({
				workingDirectory: event.workingDirectory?.toString(),
				project: event.project?.uri.toString(),
			})));

			const created = await agent.createSession({ session: sessionUri, workingDirectory: sourceWorkingDirectory });
			assert.deepStrictEqual(captures, []);
			assert.deepStrictEqual(added, []);
			const session = internals._sessions.get(AgentSession.id(created.session));
			assert.ok(session);
			await Promise.all([
				internals._materialize(session, 'Implement parallel writes now', { isolation: 'worktree', branch: 'origin/main' }),
				internals._materialize(session, 'This concurrent caller must reuse it', { isolation: 'worktree', branch: 'origin/main' }),
			]);

			const branchName = getBackboardWorktreeBranchName('worktree-session-1234', 'implement-parallel-writes-now');
			const expectedWorktreeRoot = URI.joinPath(getBackboardWorktreesRoot(repositoryRoot), branchName.replace(/\//g, '-'));
			const expectedWorkingDirectory = URI.file(path.join(expectedWorktreeRoot.fsPath, 'packages', 'desktop'));
			assert.deepStrictEqual(added, [{
				repositoryRoot: repositoryRoot.toString(),
				worktree: expectedWorktreeRoot.toString(),
				branchName,
				baseBranch: 'origin/main',
			}]);
			assert.deepStrictEqual(captures, [expectedWorkingDirectory.toString()]);
			assert.strictEqual(session.workingDirectory?.toString(), expectedWorkingDirectory.toString());
			assert.strictEqual(session.sourceWorkingDirectory?.toString(), sourceWorkingDirectory.toString());
			assert.strictEqual(session.materialized, true);
			assert.strictEqual(metadata.get('agentHost.diffBaseBranch'), 'origin/main');
			assert.strictEqual(metadata.get('backboard.worktree.branchName'), branchName);
			assert.strictEqual(metadata.get('backboard.worktree.path'), expectedWorktreeRoot.toString());
			assert.strictEqual(metadata.get('backboard.worktree.repositoryRoot'), repositoryRoot.toString());
			assert.deepStrictEqual(materializedEvents, [{
				workingDirectory: expectedWorkingDirectory.toString(),
				project: sourceWorkingDirectory.toString(),
			}]);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('deleting sessions removes clean worktrees, preserves dirty work, and cannot resurrect either session', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-cli-ts-delete-'));
		try {
			const repositoryRoot = URI.file(path.join(tempRoot, 'repo'));
			fs.mkdirSync(repositoryRoot.fsPath, { recursive: true });
			const dirtyWorktrees = new Set<string>();
			const removed: string[] = [];
			const order: string[] = [];
			const gitService = {
				getRepositoryRoot: async () => repositoryRoot,
				getWorktreeRoots: async () => [repositoryRoot],
				getCurrentBranch: async () => 'main',
				getDefaultBranch: async () => 'main',
				branchExists: async () => false,
				addWorktree: async (_repo: URI, worktree: URI) => {
					fs.mkdirSync(worktree.fsPath, { recursive: true });
				},
				hasUncommittedChanges: async (worktree: URI) => dirtyWorktrees.has(worktree.toString()),
				removeWorktree: async (_repo: URI, worktree: URI) => {
					order.push(`remove:${path.basename(worktree.fsPath)}`);
					removed.push(worktree.toString());
					fs.rmSync(worktree.fsPath, { recursive: true, force: true });
				},
			};
			const checkpointService = {
				captureBaseline: async () => undefined,
				disposeSessionData: async (sessionUri: URI) => {
					order.push(`checkpoints:${AgentSession.id(sessionUri)}`);
				},
			};
			const sessionDataService = {
				openDatabase: () => ({
					object: { setMetadata: async () => { } },
					dispose: () => { },
				}),
			};
			const agent = createAgent(checkpointService, sessionDataService, gitService);
			const storePath = path.join(tempRoot, 'cli-ts-sessions.json');
			const internals = agent as unknown as {
				_storePath(): string;
				_materialize(session: unknown, prompt: string, config?: Record<string, unknown>): Promise<void>;
				_sessions: Map<string, { worktree?: { path: URI } }>;
			};
			internals._storePath = () => storePath;

			const cleanUri = AgentSession.uri('backboard', 'clean-delete');
			const dirtyUri = AgentSession.uri('backboard', 'dirty-delete');
			for (const [sessionUri, prompt] of [[cleanUri, 'Create clean work'], [dirtyUri, 'Create dirty work']] as const) {
				await agent.createSession({ session: sessionUri, workingDirectory: repositoryRoot });
				const session = internals._sessions.get(AgentSession.id(sessionUri));
				assert.ok(session);
				await internals._materialize(session, prompt, { isolation: 'worktree', branch: 'main' });
			}
			const cleanWorktree = internals._sessions.get('clean-delete')?.worktree?.path;
			const dirtyWorktree = internals._sessions.get('dirty-delete')?.worktree?.path;
			assert.ok(cleanWorktree);
			assert.ok(dirtyWorktree);
			dirtyWorktrees.add(dirtyWorktree.toString());

			await agent.disposeSession(cleanUri);
			await agent.disposeSession(dirtyUri);

			assert.deepStrictEqual(removed, [cleanWorktree.toString()]);
			assert.strictEqual(fs.existsSync(cleanWorktree.fsPath), false);
			assert.strictEqual(fs.existsSync(dirtyWorktree.fsPath), true);
			assert.ok(order.indexOf('checkpoints:clean-delete') < order.indexOf(`remove:${path.basename(cleanWorktree.fsPath)}`));
			assert.deepStrictEqual((JSON.parse(fs.readFileSync(storePath, 'utf8')) as { sessions: unknown[] }).sessions, []);
			assert.deepStrictEqual(await agent.listSessions(), []);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('archiving removes a clean worktree and unarchiving recreates it after restart from the preserved branch', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-cli-ts-archive-'));
		try {
			const repositoryRoot = URI.file(path.join(tempRoot, 'repo'));
			fs.mkdirSync(repositoryRoot.fsPath, { recursive: true });
			const registered = new Set([repositoryRoot.toString()]);
			const branches = new Set<string>();
			const removed: string[] = [];
			const restored: Array<{ path: string; branch: string }> = [];
			const checkpointDisposals: Array<string | undefined> = [];
			let captureCalls = 0;
			let releaseCheckpointBarrier!: () => void;
			let announceCheckpointBarrier!: () => void;
			const checkpointBarrierStarted = new Promise<void>(resolve => announceCheckpointBarrier = resolve);
			const checkpointBarrier = new Promise<void>(resolve => releaseCheckpointBarrier = resolve);
			const gitService = {
				getRepositoryRoot: async () => repositoryRoot,
				getWorktreeRoots: async () => [...registered].map(value => URI.parse(value)),
				getCurrentBranch: async () => 'main',
				getDefaultBranch: async () => 'main',
				branchExists: async (_repo: URI, branchName: string) => branches.has(branchName),
				addWorktree: async (_repo: URI, worktree: URI, branchName: string) => {
					branches.add(branchName);
					registered.add(worktree.toString());
					fs.mkdirSync(worktree.fsPath, { recursive: true });
				},
				addExistingWorktree: async (_repo: URI, worktree: URI, branchName: string) => {
					assert.ok(branches.has(branchName));
					restored.push({ path: worktree.toString(), branch: branchName });
					registered.add(worktree.toString());
					fs.mkdirSync(worktree.fsPath, { recursive: true });
				},
				hasUncommittedChanges: async () => false,
				removeWorktree: async (_repo: URI, worktree: URI) => {
					removed.push(worktree.toString());
					registered.delete(worktree.toString());
					fs.rmSync(worktree.fsPath, { recursive: true, force: true });
				},
			};
			const checkpointService = {
				captureBaseline: async () => {
					captureCalls++;
					if (captureCalls === 2) {
						announceCheckpointBarrier();
						await checkpointBarrier;
					}
					return undefined;
				},
				disposeSessionData: async (_sessionUri: URI, repository?: URI) => {
					checkpointDisposals.push(repository?.toString());
				},
			};
			const sessionDataService = {
				openDatabase: () => ({
					object: { setMetadata: async () => { } },
					dispose: () => { },
				}),
			};
			const agent = createAgent(checkpointService, sessionDataService, gitService);
			const internals = agent as unknown as {
				_storePath(): string;
				_materialize(session: unknown, prompt: string, config?: Record<string, unknown>): Promise<void>;
				_sessions: Map<string, { worktree?: { path: URI; branchName: string } }>;
			};
			internals._storePath = () => path.join(tempRoot, 'cli-ts-sessions.json');
			const sessionUri = AgentSession.uri('backboard', 'archive-clean');
			await agent.createSession({ session: sessionUri, workingDirectory: repositoryRoot });
			const session = internals._sessions.get(AgentSession.id(sessionUri));
			assert.ok(session);
			await internals._materialize(session, 'Create archived work', { isolation: 'worktree', branch: 'main' });
			const worktree = session.worktree;
			assert.ok(worktree);

			const archiving = agent.onArchivedChanged(sessionUri, true);
			await checkpointBarrierStarted;
			assert.deepStrictEqual(removed, [], 'archive must wait for the checkpoint sequencer before removing cwd');
			assert.strictEqual(fs.existsSync(worktree.path.fsPath), true);
			releaseCheckpointBarrier();
			await archiving;
			assert.deepStrictEqual(removed, [worktree.path.toString()]);
			assert.strictEqual(fs.existsSync(worktree.path.fsPath), false);

			await agent.shutdown();
			const resumedAgent = createAgent(checkpointService, sessionDataService, gitService);
			const resumedInternals = resumedAgent as unknown as { _storePath(): string };
			resumedInternals._storePath = () => path.join(tempRoot, 'cli-ts-sessions.json');
			await resumedAgent.listSessions();
			assert.strictEqual(fs.existsSync(worktree.path.fsPath), false, 'catalog restoration must not recreate an archived checkout');
			await resumedAgent.onArchivedChanged(sessionUri, false);
			assert.deepStrictEqual(restored, [{ path: worktree.path.toString(), branch: worktree.branchName }]);
			assert.strictEqual(fs.existsSync(worktree.path.fsPath), true);

			await resumedAgent.onArchivedChanged(sessionUri, true);
			assert.strictEqual(fs.existsSync(worktree.path.fsPath), false);
			await resumedAgent.shutdown();
			const deletingAgent = createAgent(checkpointService, sessionDataService, gitService);
			const deletingInternals = deletingAgent as unknown as { _storePath(): string };
			deletingInternals._storePath = () => path.join(tempRoot, 'cli-ts-sessions.json');
			await deletingAgent.disposeSession(sessionUri);
			assert.deepStrictEqual(checkpointDisposals, [repositoryRoot.toString()], 'checkpoint refs must use the persisted repository even when archived cwd is absent');
			assert.deepStrictEqual(await deletingAgent.listSessions(), []);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('archiving retains dirty worktrees and worktrees whose branch is missing', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-cli-ts-archive-retain-'));
		try {
			const repositoryRoot = URI.file(path.join(tempRoot, 'repo'));
			fs.mkdirSync(repositoryRoot.fsPath, { recursive: true });
			const registered = new Set([repositoryRoot.toString()]);
			const branches = new Set<string>();
			const dirty = new Set<string>();
			const removed: string[] = [];
			const gitService = {
				getRepositoryRoot: async () => repositoryRoot,
				getWorktreeRoots: async () => [...registered].map(value => URI.parse(value)),
				getCurrentBranch: async () => 'main',
				getDefaultBranch: async () => 'main',
				branchExists: async (_repo: URI, branchName: string) => branches.has(branchName),
				addWorktree: async (_repo: URI, worktree: URI, branchName: string) => {
					branches.add(branchName);
					registered.add(worktree.toString());
					fs.mkdirSync(worktree.fsPath, { recursive: true });
				},
				hasUncommittedChanges: async (worktree: URI) => dirty.has(worktree.toString()),
				removeWorktree: async (_repo: URI, worktree: URI) => {
					removed.push(worktree.toString());
				},
			};
			const checkpointService = { captureBaseline: async () => undefined };
			const sessionDataService = {
				openDatabase: () => ({
					object: { setMetadata: async () => { } },
					dispose: () => { },
				}),
			};
			const agent = createAgent(checkpointService, sessionDataService, gitService);
			const internals = agent as unknown as {
				_storePath(): string;
				_materialize(session: unknown, prompt: string, config?: Record<string, unknown>): Promise<void>;
				_sessions: Map<string, { worktree?: { path: URI; branchName: string } }>;
			};
			internals._storePath = () => path.join(tempRoot, 'cli-ts-sessions.json');

			const dirtyUri = AgentSession.uri('backboard', 'archive-dirty');
			const missingBranchUri = AgentSession.uri('backboard', 'archive-missing-branch');
			for (const sessionUri of [dirtyUri, missingBranchUri]) {
				await agent.createSession({ session: sessionUri, workingDirectory: repositoryRoot });
				const session = internals._sessions.get(AgentSession.id(sessionUri));
				assert.ok(session);
				await internals._materialize(session, 'Create retained work', { isolation: 'worktree', branch: 'main' });
			}
			const dirtyWorktree = internals._sessions.get(AgentSession.id(dirtyUri))?.worktree;
			const missingBranchWorktree = internals._sessions.get(AgentSession.id(missingBranchUri))?.worktree;
			assert.ok(dirtyWorktree);
			assert.ok(missingBranchWorktree);
			dirty.add(dirtyWorktree.path.toString());
			branches.delete(missingBranchWorktree.branchName);

			await agent.onArchivedChanged(dirtyUri, true);
			await agent.onArchivedChanged(missingBranchUri, true);

			assert.deepStrictEqual(removed, []);
			assert.strictEqual(fs.existsSync(dirtyWorktree.path.fsPath), true);
			assert.strictEqual(fs.existsSync(missingBranchWorktree.path.fsPath), true);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('restored sessions reuse an existing worktree and recreate a missing checkout from its branch', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-cli-ts-restore-'));
		try {
			const repositoryRoot = URI.file(path.join(tempRoot, 'repo'));
			const storePath = path.join(tempRoot, 'cli-ts-sessions.json');
			fs.mkdirSync(repositoryRoot.fsPath, { recursive: true });
			const registered = new Set([repositoryRoot.toString()]);
			const branches = new Set<string>();
			let added = 0;
			let restored = 0;
			let captures = 0;
			const gitService = {
				getRepositoryRoot: async () => repositoryRoot,
				getWorktreeRoots: async () => [...registered].map(value => URI.parse(value)),
				getCurrentBranch: async () => 'main',
				getDefaultBranch: async () => 'main',
				branchExists: async (_repo: URI, branchName: string) => branches.has(branchName),
				addWorktree: async (_repo: URI, worktree: URI, branchName: string) => {
					added++;
					branches.add(branchName);
					registered.add(worktree.toString());
					fs.mkdirSync(worktree.fsPath, { recursive: true });
				},
				addExistingWorktree: async (_repo: URI, worktree: URI, branchName: string) => {
					assert.ok(branches.has(branchName));
					restored++;
					registered.add(worktree.toString());
					fs.mkdirSync(worktree.fsPath, { recursive: true });
				},
				removeWorktree: async (_repo: URI, worktree: URI) => {
					registered.delete(worktree.toString());
				},
			};
			const checkpointService = {
				captureBaseline: async () => {
					captures++;
					return undefined;
				},
				disposeSessionData: async () => { },
			};
			const sessionDataService = {
				openDatabase: () => ({
					object: { setMetadata: async () => { } },
					dispose: () => { },
				}),
			};
			const sessionUri = AgentSession.uri('backboard', 'restore-worktree');
			const createWithStore = (): {
				agent: CliTsAgent;
				internals: {
					_storePath(): string;
					_prewarm(session: unknown): Promise<void>;
					_materialize(session: unknown, prompt: string, config?: Record<string, unknown>): Promise<void>;
					_sessions: Map<string, { workingDirectory?: URI; sourceWorkingDirectory?: URI; worktree?: { path: URI } }>;
				};
			} => {
				const agent = createAgent(checkpointService, sessionDataService, gitService);
				const internals = agent as unknown as {
					_storePath(): string;
					_prewarm(session: unknown): Promise<void>;
					_materialize(session: unknown, prompt: string, config?: Record<string, unknown>): Promise<void>;
					_sessions: Map<string, { workingDirectory?: URI; sourceWorkingDirectory?: URI; worktree?: { path: URI } }>;
				};
				internals._storePath = () => storePath;
				internals._prewarm = async () => { };
				return { agent, internals };
			};

			const first = createWithStore();
			await first.agent.createSession({ session: sessionUri, workingDirectory: repositoryRoot });
			const firstSession = first.internals._sessions.get('restore-worktree');
			assert.ok(firstSession);
			await first.internals._materialize(firstSession, 'Build the restore flow', { isolation: 'worktree', branch: 'main' });
			const expectedWorkingDirectory = firstSession.workingDirectory;
			const worktreeRoot = firstSession.worktree?.path;
			assert.ok(expectedWorkingDirectory);
			assert.ok(worktreeRoot);
			await first.agent.shutdown();

			const second = createWithStore();
			const existing = await second.agent.createSession({ session: sessionUri });
			assert.strictEqual(existing.workingDirectory?.toString(), expectedWorkingDirectory.toString());
			assert.strictEqual(existing.project?.uri.toString(), repositoryRoot.toString());
			assert.strictEqual(added, 1);
			assert.strictEqual(restored, 0);
			assert.strictEqual(captures, 1);
			await second.agent.shutdown();

			registered.delete(worktreeRoot.toString());
			fs.rmSync(worktreeRoot.fsPath, { recursive: true, force: true });
			const third = createWithStore();
			const recreated = await third.agent.createSession({ session: sessionUri });
			assert.strictEqual(recreated.workingDirectory?.toString(), expectedWorkingDirectory.toString());
			assert.strictEqual(recreated.project?.uri.toString(), repositoryRoot.toString());
			assert.strictEqual(restored, 1);
			assert.strictEqual(captures, 1);
			assert.strictEqual(fs.existsSync(worktreeRoot.fsPath), true);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('deletion waits for in-flight worktree creation and rolls back the new checkout', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-cli-ts-materialize-delete-'));
		try {
			const repositoryRoot = URI.file(path.join(tempRoot, 'repo'));
			fs.mkdirSync(repositoryRoot.fsPath, { recursive: true });
			let releaseAdd!: () => void;
			let announceAddStarted!: () => void;
			const addStarted = new Promise<void>(resolve => announceAddStarted = resolve);
			const addGate = new Promise<void>(resolve => releaseAdd = resolve);
			let removed = 0;
			let captures = 0;
			let metadataWrites = 0;
			let checkpointDisposals = 0;
			const gitService = {
				getRepositoryRoot: async () => repositoryRoot,
				getWorktreeRoots: async () => [repositoryRoot],
				getCurrentBranch: async () => 'main',
				getDefaultBranch: async () => 'main',
				branchExists: async () => false,
				addWorktree: async (_repo: URI, worktree: URI) => {
					fs.mkdirSync(worktree.fsPath, { recursive: true });
					announceAddStarted();
					await addGate;
				},
				hasUncommittedChanges: async () => false,
				removeWorktree: async (_repo: URI, worktree: URI) => {
					removed++;
					fs.rmSync(worktree.fsPath, { recursive: true, force: true });
				},
			};
			const checkpointService = {
				captureBaseline: async () => {
					captures++;
					return undefined;
				},
				disposeSessionData: async () => {
					checkpointDisposals++;
				},
			};
			const sessionDataService = {
				openDatabase: () => ({
					object: {
						setMetadata: async () => {
							metadataWrites++;
						},
					},
					dispose: () => { },
				}),
			};
			const agent = createAgent(checkpointService, sessionDataService, gitService);
			const internals = agent as unknown as {
				_storePath(): string;
				_materialize(session: unknown, prompt: string, config?: Record<string, unknown>): Promise<void>;
				_sessions: Map<string, unknown>;
			};
			internals._storePath = () => path.join(tempRoot, 'cli-ts-sessions.json');
			const sessionUri = AgentSession.uri('backboard', 'delete-during-add');
			await agent.createSession({ session: sessionUri, workingDirectory: repositoryRoot });
			const session = internals._sessions.get('delete-during-add');
			assert.ok(session);
			const materializing = internals._materialize(session, 'Create an isolated checkout', { isolation: 'worktree', branch: 'main' });
			await addStarted;
			const deleting = agent.disposeSession(sessionUri);
			releaseAdd();

			await assert.rejects(materializing, /disposed Backboard session/);
			await deleting;
			assert.strictEqual(metadataWrites, 0);
			assert.strictEqual(captures, 0);
			assert.strictEqual(checkpointDisposals, 1);
			assert.strictEqual(removed, 1);
			assert.deepStrictEqual(await agent.listSessions(), []);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('Stop during first-send worktree creation prevents the runtime submit', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-cli-ts-materialize-stop-'));
		try {
			const repositoryRoot = URI.file(path.join(tempRoot, 'repo'));
			fs.mkdirSync(repositoryRoot.fsPath, { recursive: true });
			let releaseAdd!: () => void;
			let announceAddStarted!: () => void;
			const addStarted = new Promise<void>(resolve => announceAddStarted = resolve);
			const addGate = new Promise<void>(resolve => releaseAdd = resolve);
			const gitService = {
				getRepositoryRoot: async () => repositoryRoot,
				getWorktreeRoots: async () => [repositoryRoot],
				getCurrentBranch: async () => 'main',
				getDefaultBranch: async () => 'main',
				branchExists: async () => false,
				addWorktree: async (_repo: URI, worktree: URI) => {
					fs.mkdirSync(worktree.fsPath, { recursive: true });
					announceAddStarted();
					await addGate;
				},
			};
			const checkpointService = {
				captureBaseline: async () => undefined,
			};
			const sessionDataService = {
				openDatabase: () => ({
					object: { setMetadata: async () => { } },
					dispose: () => { },
				}),
			};
			const configurationService = {
				getSessionConfigValues: () => ({ isolation: 'worktree', branch: 'main' }),
			};
			const agent = createAgent(checkpointService, sessionDataService, gitService, configurationService);
			let processStarts = 0;
			const internals = agent as unknown as {
				_storePath(): string;
				_ensureProcess(session: unknown, rgDir?: string): unknown;
			};
			internals._storePath = () => path.join(tempRoot, 'cli-ts-sessions.json');
			internals._ensureProcess = () => {
				processStarts++;
				throw new Error('The serve process must not start after Stop');
			};
			const sessionUri = AgentSession.uri('backboard', 'stop-during-add');
			await agent.createSession({ session: sessionUri, workingDirectory: repositoryRoot });
			const sending = agent.sendMessage(sessionUri, 'Create an isolated checkout');
			await addStarted;
			await agent.abortSession(sessionUri);
			releaseAdd();
			await sending;

			assert.strictEqual(processStarts, 0);
			assert.strictEqual(fs.existsSync(path.join(tempRoot, 'cli-ts-sessions.json')), true);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('Stop consumes the cancellation-safe AgentSpawn lifecycle edge', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-cli-ts-detached-stop-'));
		try {
			const progress: AgentSignal[] = [];
			const agent = createAgent(
				{ captureBaseline: async () => undefined },
				{},
				{},
				{ getSessionConfigValues: () => ({ isolation: 'folder' }) },
			);
			store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
			let announceSubmitStarted!: () => void;
			const submitStarted = new Promise<void>(resolve => announceSubmitStarted = resolve);
			let finishCancelledSubmit!: () => void;
			const cancelledSubmit = new Promise<{ payload: { status: 'cancelled' } }>(resolve => {
				finishCancelledSubmit = () => resolve({ payload: { status: 'cancelled' } });
			});
			let requestId = 0;
			const sessionUri = AgentSession.uri('backboard', 'detached-stop-lifecycle');
			const internals = agent as unknown as {
				_storePath(): string;
				_modelsRefreshed: boolean;
				_sessions: Map<string, unknown>;
				_resolveRgDir(): Promise<string | undefined>;
				_ensureProcess(session: { proc?: unknown }): unknown;
				_handleAgentEvent(session: unknown, event: unknown): void;
			};
			internals._storePath = () => path.join(tempRoot, 'cli-ts-sessions.json');
			internals._modelsRefreshed = true;
			internals._resolveRgDir = async () => undefined;
			const proc = {
				isRunning: true,
				isInvocationStale: false,
				start: () => undefined,
				nextRequestId: () => `request-${++requestId}`,
				request: async (request: { op: string }) => {
					if (request.op !== 'submit') {
						return { payload: { models: [] } };
					}
					const session = internals._sessions.get(AgentSession.id(sessionUri));
					assert.ok(session);
					internals._handleAgentEvent(session, {
						type: 'tool:requested',
						calls: [{ id: 'spawn-stop-1', name: 'AgentSpawn', input: { prompt: 'Keep working until stopped.' } }],
					});
					internals._handleAgentEvent(session, {
						type: 'tool:start',
						toolCallId: 'spawn-stop-1',
						name: 'AgentSpawn',
						inputSummary: 'Keep working until stopped.',
					});
					internals._handleAgentEvent(session, {
						type: 'agent:child_start',
						agentToolCallId: 'spawn-stop-1',
						childSessionId: 'child-spawn-stop-1',
						prompt: 'Keep working until stopped.',
						workspace: {
							workerId: 'spawn-stop-1', status: 'Running', changedFileCount: 0,
							startedAt: '2026-09-01T12:00:00.000Z',
						},
					});
					announceSubmitStarted();
					return cancelledSubmit;
				},
				notify: (notification: { op: string }) => {
					if (notification.op === 'cancel') {
						const session = internals._sessions.get(AgentSession.id(sessionUri));
						assert.ok(session);
						internals._handleAgentEvent(session, {
							type: 'agent:child_status',
							agentToolCallId: 'spawn-stop-1',
							workspace: {
								workerId: 'spawn-stop-1', status: 'Cancelled', changedFileCount: 0,
								startedAt: '2026-09-01T12:00:00.000Z', finishedAt: '2026-09-01T12:00:01.000Z',
							},
						});
						internals._handleAgentEvent(session, {
							type: 'agent:child_end', agentToolCallId: 'spawn-stop-1', status: 'cancelled',
						});
						finishCancelledSubmit();
					}
				},
				dispose: () => undefined,
			};
			internals._ensureProcess = session => {
				session.proc = proc;
				return proc;
			};

			await agent.createSession({ session: sessionUri, workingDirectory: URI.file(tempRoot) });
			const sending = agent.sendMessage(sessionUri, 'Spawn a worker, then wait.');
			await submitStarted;
			await agent.abortSession(sessionUri);
			await sending;

			assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_started').length, 1);
			assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_completed').length, 1);
			assert.ok(progress.some(signal => signal.kind === 'action'
				&& signal.parentToolCallId === 'spawn-stop-1'
				&& signal.action.type === ActionType.ChatTurnCancelled));
			const session = internals._sessions.get(AgentSession.id(sessionUri)) as {
				subagentTurnOwners: Map<string, unknown>;
				completedSubagentToolCallIds: Set<string>;
			};
			assert.strictEqual(session.subagentTurnOwners.has('spawn-stop-1'), false);
			assert.strictEqual(session.completedSubagentToolCallIds.has('spawn-stop-1'), true);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	for (const scenario of ['run-error', 'send-rejection', 'run-error-then-rejection', 'failed-payload', 'completed'] as const) {
		test(`${scenario} preserves the visible turn outcome through durable reopen`, async () => {
			const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-cli-ts-turn-error-'));
			try {
				const storePath = path.join(tempRoot, 'sessions.json');
				const agent = createAgent({}, {}, {}, { getSessionConfigValues: () => ({ isolation: 'folder' }) });
				const progress: AgentSignal[] = [];
				store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
				const internals = agent as unknown as {
					_storePath(): string;
					_materialize(session: { materialized: boolean }): Promise<void>;
					_resolveRgDir(): Promise<string | undefined>;
					_refreshModelsOnce(): void;
					_ensureProcess(session: unknown): unknown;
					_handleAgentEvent(session: unknown, event: unknown): void;
				};
				internals._storePath = () => storePath;
				internals._materialize = async session => { session.materialized = true; };
				internals._resolveRgDir = async () => undefined;
				internals._refreshModelsOnce = () => { };
				internals._ensureProcess = session => ({
					nextRequestId: () => 'fixture-request',
					request: async () => {
						internals._handleAgentEvent(session, { type: 'assistant:reasoning', text: 'Synthetic pending work.' });
						if (scenario === 'run-error' || scenario === 'run-error-then-rejection') {
							internals._handleAgentEvent(session, { type: 'run:error', error: 'Provider response contained inconsistent tool calls.' });
						}
						if (scenario === 'send-rejection' || scenario === 'run-error-then-rejection') {
							throw new Error('The serve process closed before completing the request.');
						}
						return { payload: { status: scenario === 'completed' ? 'completed' : 'failed' } };
					},
				});
				const sessionUri = AgentSession.uri('backboard', `durable-${scenario}`);
				await agent.createSession({ session: sessionUri, workingDirectory: URI.file(tempRoot), model: { id: 'google/gemini-3-pro' } });
				await agent.sendMessage(sessionUri, 'Inspect the requested behavior.');

				const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8')) as { sessions: Array<{ turns: Array<{ failed?: boolean; error?: { errorType: string; message: string } }> }> };
				const expectedMessage = scenario === 'run-error' || scenario === 'run-error-then-rejection'
					? 'Provider response contained inconsistent tool calls.'
					: scenario === 'send-rejection'
						? 'The serve process closed before completing the request.'
						: scenario === 'failed-payload' ? 'The Backboard agent reported a failed turn.' : undefined;
				assert.strictEqual(persisted.sessions[0].turns[0].error?.message, expectedMessage);
				assert.strictEqual(failureNotes(progress).length, expectedMessage ? 1 : 0, 'A later generic failure must not add a second note');
				const reopened = createAgent();
				(reopened as unknown as { _storePath(): string })._storePath = () => storePath;
				const turns = await reopened.getSessionMessages(sessionUri);
				// The cause stays in the store; the chat shows a calm note, never an error.
				const lastPart = turns[0].responseParts.at(-1);
				assert.deepStrictEqual({
					state: turns[0].state,
					error: turns[0].error,
					first: turns[0].responseParts[0].kind,
					note: lastPart?.kind === ResponsePartKind.Markdown && lastPart.content.startsWith('_This response'),
				}, {
					state: TurnState.Complete,
					error: undefined,
					first: ResponsePartKind.Reasoning,
					note: !!expectedMessage,
				});
			} finally {
				fs.rmSync(tempRoot, { recursive: true, force: true });
			}
		});
	}

	test('an error-only child archive preserves its failure without a markdown or tool part', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-cli-ts-child-error-'));
		try {
			fs.writeFileSync(path.join(tempRoot, 'meta.json'), JSON.stringify({ prompt: 'Inspect a source file.' }));
			fs.writeFileSync(path.join(tempRoot, 'client.jsonl'), [
				{ payload: { type: 'run:error', error: 'The provider connection ended unexpectedly.' } },
				{ payload: { type: 'turn:end', status: 'failed' } },
			].map(record => JSON.stringify(record)).join('\n'));
			const agent = createAgent();
			const recovery = await (agent as unknown as {
				_readRuntimeSubagentRecoveryFromDirectory(directory: string): Promise<{ turn: { failed?: boolean; error?: { message: string }; parts: unknown[] } } | undefined>;
			})._readRuntimeSubagentRecoveryFromDirectory(tempRoot);
			assert.strictEqual(recovery?.turn.failed, true);
			assert.strictEqual(recovery?.turn.error?.message, 'The provider connection ended unexpectedly.');
			assert.deepStrictEqual(recovery?.turn.parts, []);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('legacy failed turns end with a calm note without inventing its original cause', async () => {
		const agent = createAgent();
		const sessionUri = AgentSession.uri('backboard', 'legacy-failed-turn');
		(agent as unknown as { _sessions: Map<string, unknown> })._sessions.set(AgentSession.id(sessionUri), {
			storedTurns: [
				{ prompt: 'Inspect the task', response: '', failed: true, parts: [{ kind: 'reasoning', content: 'Synthetic pending work.' }] },
				{ prompt: 'Retry', response: '', failed: true, error: { message: 42 } },
			],
		});
		const turns = await agent.getSessionMessages(sessionUri);
		assert.deepStrictEqual(turns.map(turn => [turn.state, turn.error, turn.responseParts.at(-1)]), turns.map((turn, index) => [
			TurnState.Complete,
			undefined,
			{ kind: ResponsePartKind.Markdown, id: `${AgentSession.id(sessionUri)}-${index}-note`, content: '_This response stopped before it finished. Send a message to continue from here._' },
		]));
	});

	test('in-flight first turns survive shutdown and legacy zero-turn sessions remain openable', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-cli-ts-interrupted-turn-'));
		try {
			const storePath = path.join(tempRoot, 'cli-ts-sessions.json');
			const configurationService = {
				getSessionConfigValues: () => ({ isolation: 'folder' }),
			};
			let baselineStarted!: () => void;
			const didStartBaseline = new Promise<void>(resolve => baselineStarted = resolve);
			let releaseBaseline!: () => void;
			const baselineGate = new Promise<void>(resolve => releaseBaseline = resolve);
			const checkpointService = {
				captureBaseline: async () => {
					baselineStarted();
					await baselineGate;
				},
			};
			const agent = createAgent(checkpointService, {}, {}, configurationService);
			let requestStarted!: () => void;
			const didStartRequest = new Promise<void>(resolve => requestStarted = resolve);
			let rejectRequest!: (error: Error) => void;
			const proc = {
				isRunning: true,
				nextRequestId: () => 'request-interrupted',
				request: () => new Promise<never>((_resolve, reject) => {
					rejectRequest = reject;
					requestStarted();
				}),
				notify: () => undefined,
				dispose: () => rejectRequest(new Error('cli-ts serve process disposed.')),
			};
			const internals = agent as unknown as {
				_storePath(): string;
				_resolveRgDir(): Promise<string | undefined>;
				_ensureProcess(session: { proc?: unknown }): unknown;
			};
			internals._storePath = () => storePath;
			internals._resolveRgDir = async () => undefined;
			internals._ensureProcess = session => {
				session.proc = proc;
				return proc;
			};

			const sessionUri = AgentSession.uri('backboard', 'interrupted-first-turn');
			await agent.createSession({ session: sessionUri, workingDirectory: URI.file(tempRoot) });
			const sending = agent.sendMessage(sessionUri, 'Keep this exact prompt after closing');
			await didStartBaseline;
			const provisionalStore = JSON.parse(fs.readFileSync(storePath, 'utf8')) as { sessions: Array<{ materialized?: boolean; turns: Array<{ prompt: string }> }> };
			assert.strictEqual(provisionalStore.sessions[0].materialized, false);
			assert.strictEqual(provisionalStore.sessions[0].turns[0].prompt, 'Keep this exact prompt after closing');
			releaseBaseline();
			await didStartRequest;

			const inFlightStore = JSON.parse(fs.readFileSync(storePath, 'utf8')) as { sessions: Array<{ turns: Array<{ prompt: string; failed?: boolean }> }> };
			assert.strictEqual(inFlightStore.sessions[0].turns[0].prompt, 'Keep this exact prompt after closing');
			assert.strictEqual(inFlightStore.sessions[0].turns[0].failed, true);

			await agent.shutdown();
			await sending;
			const restored = await agent.getSessionMessages(sessionUri);
			assert.strictEqual(restored.length, 1);
			assert.strictEqual(restored[0].message.text, 'Keep this exact prompt after closing');
			assert.strictEqual(restored[0].state, TurnState.Complete);
			assert.strictEqual(restored[0].responseParts[0]?.kind, ResponsePartKind.Markdown);

			fs.writeFileSync(storePath, JSON.stringify({
				version: 1,
				sessions: [{
					id: 'legacy-zero-turn',
					title: 'Prompt retained only in the old title',
					cwd: tempRoot,
					createdAt: 1,
					modifiedAt: 2,
					turns: [],
				}],
			}), 'utf8');
			const legacy = await agent.getSessionMessages(AgentSession.uri('backboard', 'legacy-zero-turn'));
			assert.strictEqual(legacy.length, 1);
			assert.strictEqual(legacy[0].message.text, 'Prompt retained only in the old title');
			assert.strictEqual(legacy[0].state, TurnState.Complete);
			assert.strictEqual(legacy[0].responseParts[0]?.kind, ResponsePartKind.Markdown);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('Multitask steering preserves hidden coordinator guidance', () => {
		const agent = createAgent({}, {}, {}, {
			getSessionConfigValues: () => ({ mode: 'multitask' }),
		});
		const sessionUri = AgentSession.uri('backboard', 'multitask-steer');
		const notifications: unknown[] = [];
		const internals = agent as unknown as { _sessions: Map<string, unknown> };
		internals._sessions.set(AgentSession.id(sessionUri), {
			sessionUri,
			proc: {
				isRunning: true,
				notify: (control: unknown) => notifications.push(control),
				dispose: () => undefined,
			},
			pendingInputs: new Map(),
		});

		agent.setPendingMessages(sessionUri, {
			id: 'steer-1',
			message: { text: 'Also update the tests.' },
		} as never, []);

		assert.strictEqual(notifications.length, 1);
		const notification = notifications[0] as { op?: string; prompt?: string; systemContext?: string };
		assert.strictEqual(notification.op, 'steer');
		assert.strictEqual(notification.prompt, 'Also update the tests.');
		assert.match(notification.systemContext ?? '', /same assistant message/);
		assert.match(notification.systemContext ?? '', /non-overlapping set of files/);
	});

	test('Execute tool start advertises terminal metadata', () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'execute-live');
		const internals = agent as unknown as {
			_ensureToolCallStart(
				session: { sessionUri: typeof sessionUri },
				turn: { turnId: string; startedToolCalls: Set<string>; toolInputSummaries: Map<string, string>; toolInputs: Map<string, { name: string; input: unknown }> },
				toolCallId: string,
				toolName: string,
				inputSummary?: string,
			): void;
		};
		const turn = {
			turnId: 'turn-execute',
			startedToolCalls: new Set<string>(),
			toolInputSummaries: new Map<string, string>(),
			toolInputs: new Map<string, { name: string; input: unknown }>(),
		};

		internals._ensureToolCallStart({ sessionUri }, turn, 'call-execute', 'Execute', 'printf ready');
		internals._ensureToolCallStart({ sessionUri }, turn, 'call-execute', 'Execute', 'printf ready');

		const starts = progress
			.filter(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallStart)
			.map(signal => signal.kind === 'action' ? signal.action : undefined);
		assert.strictEqual(starts.length, 1, 'Repeated lifecycle events should reuse the original terminal start');
		assert.deepStrictEqual(starts[0], {
			type: ActionType.ChatToolCallStart,
			turnId: 'turn-execute',
			toolCallId: 'call-execute',
			toolName: 'Execute',
			displayName: 'Execute',
			_meta: { source: 'cli-ts', toolKind: 'terminal', language: 'shellscript' },
		});
	});

	test('Execute streams and completes with the full terminal transcript', async () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'execute-output');
		const command = 'printf output && printf "\\nall done\\n"';
		const turn = {
			turnId: 'turn-execute-output',
			messageParts: new Map(),
			streamedText: new Map(),
			startedToolCalls: new Set<string>(),
			confirmedToolCalls: new Set<string>(),
			childToolLines: new Map<string, Map<string, string>>(),
			toolSummaries: [] as string[],
			storedParts: [] as Array<{ kind: string; terminalCommand?: string; terminalOutput?: unknown; failed?: boolean }>,
			storedTextParts: new Map(),
			toolInputs: new Map([['execute-full-output', { name: 'Execute', input: { command } }]]),
			toolInputSummaries: new Map<string, string>(),
			terminalOutputs: new Map<string, string>(),
			pendingCompletions: [] as Promise<void>[],
			subagentTurns: new Map(),
			workerWorkspaces: new Map(),
			responseText: '',
			reasoningText: '',
		};
		const internals = agent as unknown as {
			_handleMappedAgentEvent(session: { sessionUri: typeof sessionUri }, event: unknown, turn: unknown): void;
		};
		const session = { sessionUri };

		internals._handleMappedAgentEvent(session, {
			type: 'tool:start',
			toolCallId: 'execute-full-output',
			name: 'Execute',
			inputSummary: 'printf output …',
		}, turn);
		internals._handleMappedAgentEvent(session, {
			type: 'tool:progress',
			toolCallId: 'execute-full-output',
			data: { kind: 'terminal-output', text: 'first\nsecond\n' },
		}, turn);
		internals._handleMappedAgentEvent(session, {
			type: 'tool:progress',
			toolCallId: 'execute-full-output',
			data: { kind: 'terminal-output', text: 'third\n' },
		}, turn);
		internals._handleMappedAgentEvent(session, {
			type: 'tool:result',
			toolCallId: 'execute-full-output',
			name: 'Execute',
			title: 'Failed: verification failed',
			detail: '$ printf output\nstdout:\nfirst\n… +2 more',
			terminalOutput: {
				text: 'first\nsecond\nthird\nverification failed',
				exitCode: 7,
			},
		}, turn);
		await Promise.allSettled(turn.pendingCompletions);

		const ready = progress.find(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallReady);
		assert.ok(ready?.kind === 'action' && ready.action.type === ActionType.ChatToolCallReady);
		assert.ok(ready.action.toolInput);
		assert.deepStrictEqual(JSON.parse(ready.action.toolInput), { command });
		const contentChanges = progress.filter(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallContentChanged);
		const latestContentChange = contentChanges.at(-1);
		assert.ok(latestContentChange?.kind === 'action' && latestContentChange.action.type === ActionType.ChatToolCallContentChanged);
		assert.deepStrictEqual(latestContentChange.action.content, [{ type: ToolResultContentType.Text, text: 'first\nsecond\nthird\n' }]);
		const completion = progress.findLast(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallComplete);
		assert.ok(completion?.kind === 'action' && completion.action.type === ActionType.ChatToolCallComplete);
		assert.deepStrictEqual({
			success: completion.action.result.success,
			failed: turn.storedParts[0]?.failed,
			meta: completion.action._meta,
			content: completion.action.result.content,
		}, {
			success: false,
			failed: true,
			meta: { source: 'cli-ts', toolKind: 'terminal', language: 'shellscript', terminalExitCode: 7 },
			content: [{ type: ToolResultContentType.Text, text: 'first\nsecond\nthird\nverification failed' }],
		});
		assert.deepStrictEqual(turn.storedParts[0]?.terminalOutput, {
			text: 'first\nsecond\nthird\nverification failed',
			exitCode: 7,
		});
		assert.strictEqual(turn.storedParts[0]?.terminalCommand, command);
	});

	test('core tool UI data maps to actions and survives stored-turn replay', async () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'read-ui-transport');
		const storedParts: unknown[] = [];
		const turn = {
			turnId: 'turn-read-ui',
			messageParts: new Map(),
			streamedText: new Map(),
			startedToolCalls: new Set<string>(),
			confirmedToolCalls: new Set<string>(),
			childToolLines: new Map<string, Map<string, string>>(),
			toolSummaries: [] as string[],
			storedParts,
			storedTextParts: new Map(),
			toolInputs: new Map([['read-ui', { name: 'Read', input: { file_path: '/workspace/app.ts', offset: 4, limit: 8 } }]]),
			toolInputSummaries: new Map<string, string>(),
			toolUi: new Map(),
			terminalOutputs: new Map<string, string>(),
			pendingCompletions: [] as Promise<void>[],
			subagentTurns: new Map(),
			workerWorkspaces: new Map(),
			responseText: '',
			reasoningText: '',
		};
		const internals = agent as unknown as {
			_handleMappedAgentEvent(session: { sessionUri: typeof sessionUri }, event: unknown, turn: unknown): void;
			_sessions: Map<string, unknown>;
		};
		const session = { sessionUri };
		const input = { file_path: '/workspace/app.ts', offset: 4, limit: 8 };
		const result = { filePath: '/workspace/app.ts', content: 'export const ready = true;', totalLines: 24, truncated: true };

		internals._handleMappedAgentEvent(session, {
			type: 'tool:start',
			toolCallId: 'read-ui',
			name: 'Read',
			inputSummary: 'app.ts:5-12',
			toolUi: { kind: 'read', input },
		}, turn);
		internals._handleMappedAgentEvent(session, {
			type: 'tool:result',
			toolCallId: 'read-ui',
			name: 'Read',
			title: 'Read 8/24 lines',
			toolUi: { kind: 'read', input, result },
		}, turn);
		await Promise.allSettled(turn.pendingCompletions);

		const ready = progress.find(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallReady);
		assert.ok(ready?.kind === 'action' && ready.action.type === ActionType.ChatToolCallReady);
		assert.ok(ready.action.toolInput);
		assert.deepStrictEqual(JSON.parse(ready.action.toolInput), input);
		assert.deepStrictEqual(ready.action._meta, { source: 'cli-ts', backboardToolKind: 'read' });
		const completion = progress.find(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallComplete);
		assert.ok(completion?.kind === 'action' && completion.action.type === ActionType.ChatToolCallComplete);
		assert.deepStrictEqual(completion.action._meta, { source: 'cli-ts', backboardToolKind: 'read' });
		assert.deepStrictEqual(completion.action.result.structuredContent, { backboardTool: result });

		internals._sessions.set(AgentSession.id(sessionUri), {
			storedTurns: [{ prompt: 'Read the implementation', response: '', parts: storedParts }],
		});
		const replayed = await agent.getSessionMessages(sessionUri);
		const replayedPart = replayed[0]?.responseParts[0] as ToolCallResponsePart;
		assert.strictEqual(replayedPart.kind, ResponsePartKind.ToolCall);
		assert.strictEqual(replayedPart.toolCall.status, ToolCallStatus.Completed);
		if (replayedPart.toolCall.status !== ToolCallStatus.Completed) { return; }
		assert.ok(replayedPart.toolCall.toolInput);
		assert.deepStrictEqual(JSON.parse(replayedPart.toolCall.toolInput), input);
		assert.deepStrictEqual(replayedPart.toolCall.structuredContent, { backboardTool: result });
		assert.deepStrictEqual(replayedPart.toolCall._meta, { source: 'cli-ts', backboardToolKind: 'read' });
	});

	test('one provider mutation response shares a stable batch and separate responses never merge', async () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'mutation-batch-transport');
		const turn = {
			turnId: 'turn-mutations',
			messageParts: new Map(),
			streamedText: new Map(),
			startedToolCalls: new Set<string>(),
			confirmedToolCalls: new Set<string>(),
			childToolLines: new Map<string, Map<string, string>>(),
			toolSummaries: [] as string[],
			storedParts: [] as Array<{ kind: string; id?: string; mutationBatch?: { id: string; expectedFileCount: number } }>,
			storedTextParts: new Map(),
			toolInputs: new Map<string, { name: string; input: unknown }>(),
			toolInputSummaries: new Map<string, string>(),
			mutationBatches: new Map(),
			toolUi: new Map(),
			terminalOutputs: new Map<string, string>(),
			pendingCompletions: [] as Promise<void>[],
			subagentTurns: new Map(),
			workerWorkspaces: new Map(),
			responseText: '',
			reasoningText: '',
		};
		const internals = agent as unknown as {
			_handleMappedAgentEvent(session: { sessionUri: typeof sessionUri }, event: unknown, turn: unknown): void;
			_sessions: Map<string, unknown>;
		};
		const session = { sessionUri };
		const firstRound = [
			{ id: 'write-a', name: 'Write', input: { file_path: 'a.ts', content: 'a' } },
			{ id: 'edit-b', name: 'Edit', input: { file_path: 'b.ts', edits: [] } },
			{ id: 'patch-cd', name: 'ApplyPatch', input: { patch: '*** Begin Patch\n*** Update File: c.ts\n*** Add File: d.ts\n*** End Patch' } },
		];
		internals._handleMappedAgentEvent(session, { type: 'tool:requested', calls: firstRound }, turn);
		for (const call of firstRound) {
			internals._handleMappedAgentEvent(session, { type: 'tool:start', toolCallId: call.id, name: call.name }, turn);
			internals._handleMappedAgentEvent(session, { type: 'tool:result', toolCallId: call.id, name: call.name }, turn);
		}
		internals._handleMappedAgentEvent(session, {
			type: 'tool:requested',
			calls: [{ id: 'write-next', name: 'Write', input: { file_path: 'next.ts', content: 'next' } }],
		}, turn);
		internals._handleMappedAgentEvent(session, { type: 'tool:start', toolCallId: 'write-next', name: 'Write' }, turn);
		internals._handleMappedAgentEvent(session, { type: 'tool:result', toolCallId: 'write-next', name: 'Write' }, turn);
		await Promise.allSettled(turn.pendingCompletions);

		const starts = progress
			.filter(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallStart)
			.map(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallStart ? signal.action : undefined)
			.filter((action): action is NonNullable<typeof action> => !!action);
		const firstBatchIds = starts.filter(action => firstRound.some(call => call.id === action.toolCallId)).map(action => action._meta?.mutationBatchId);
		assert.strictEqual(new Set(firstBatchIds).size, 1);
		assert.strictEqual(starts.find(action => action.toolCallId === 'write-a')?._meta?.mutationBatchFileCount, 4);
		assert.notStrictEqual(starts.find(action => action.toolCallId === 'write-next')?._meta?.mutationBatchId, firstBatchIds[0]);
		assert.deepStrictEqual(starts.map(action => action.toolCallId), ['write-a', 'edit-b', 'patch-cd', 'write-next']);

		const storedFirstBatchIds = turn.storedParts.slice(0, 3).map(part => part.mutationBatch?.id);
		assert.strictEqual(new Set(storedFirstBatchIds).size, 1);
		internals._sessions.set(AgentSession.id(sessionUri), {
			storedTurns: [{ prompt: 'Update four files', response: '', parts: turn.storedParts }],
		});
		const replayed = await agent.getSessionMessages(sessionUri);
		const replayedCalls = replayed[0]?.responseParts.filter((part): part is ToolCallResponsePart => part.kind === ResponsePartKind.ToolCall) ?? [];
		assert.strictEqual(replayedCalls[0]?.toolCall._meta?.mutationBatchId, firstBatchIds[0]);
		assert.strictEqual(replayedCalls[3]?.toolCall._meta?.mutationBatchId, starts.find(action => action.toolCallId === 'write-next')?._meta?.mutationBatchId);
	});

	test('starts one provisional mutation batch while large Write inputs are still streaming', () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'mutation-input-streaming');
		const turn = {
			turnId: 'turn-streaming-write',
			messageParts: new Map(),
			streamedText: new Map(),
			startedToolCalls: new Set<string>(),
			confirmedToolCalls: new Set<string>(),
			childToolLines: new Map<string, Map<string, string>>(),
			toolSummaries: [] as string[],
			storedParts: [],
			storedTextParts: new Map(),
			toolInputs: new Map<string, { name: string; input: unknown }>(),
			toolInputSummaries: new Map<string, string>(),
			mutationBatches: new Map(),
			toolUi: new Map(),
			terminalOutputs: new Map<string, string>(),
			pendingCompletions: [] as Promise<void>[],
			subagentTurns: new Map(),
			workerWorkspaces: new Map(),
			pendingSubagentEndStatuses: new Map(),
			responseText: '',
			reasoningText: '',
		};
		const internals = agent as unknown as {
			_handleMappedAgentEvent(session: { sessionUri: typeof sessionUri }, event: unknown, turn: unknown): void;
		};
		const session = { sessionUri };

		internals._handleMappedAgentEvent(session, {
			// OpenRouter can expose the function name before it exposes the real
			// provider call id. The raw-stream mapper uses a provisional id here;
			// tool:requested later carries the authoritative ids.
			type: 'tool:pending', toolCallId: 'backboard_stream_1_0', name: 'Write', inputSummary: 'Generating input…'
		}, turn);

		const earlyStarts = progress
			.filter(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallStart)
			.map(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallStart ? signal.action : undefined)
			.filter((action): action is NonNullable<typeof action> => !!action);
		assert.deepStrictEqual(earlyStarts.map(action => action.toolCallId), ['backboard_stream_1_0']);

		internals._handleMappedAgentEvent(session, {
			type: 'tool:requested',
			calls: [
				{ id: 'write-large', name: 'Write', input: { file_path: 'large.ts', content: 'large payload' } },
				{ id: 'edit-next', name: 'Edit', input: { file_path: 'next.ts', edits: [] } },
			],
		}, turn);
		internals._handleMappedAgentEvent(session, { type: 'tool:start', toolCallId: 'write-large', name: 'Write' }, turn);

		const ready = progress.find(signal => signal.kind === 'action'
			&& signal.action.type === ActionType.ChatToolCallReady
			&& signal.action.toolCallId === 'write-large');
		assert.ok(ready?.kind === 'action' && ready.action.type === ActionType.ChatToolCallReady);
		assert.strictEqual(ready.action._meta?.mutationBatchId, earlyStarts[0]._meta?.mutationBatchId);
		assert.strictEqual(ready.action._meta?.mutationBatchFileCount, 2);
	});

	test('Agent tool start advertises a named subagent task', () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'subagent-live');
		const internals = agent as unknown as {
			_ensureToolCallStart(
				session: { sessionUri: typeof sessionUri },
				turn: { turnId: string; startedToolCalls: Set<string>; toolInputSummaries: Map<string, string>; toolInputs: Map<string, { name: string; input: unknown }> },
				toolCallId: string,
				toolName: string,
				inputSummary?: string,
			): void;
		};
		const turn = {
			turnId: 'turn-subagent',
			startedToolCalls: new Set<string>(),
			toolInputSummaries: new Map<string, string>(),
			toolInputs: new Map([['call-agent', { name: 'agent', input: { subagent_type: 'worker', prompt: 'Inspect the renderer and report back.' } }]]),
		};

		internals._ensureToolCallStart({ sessionUri }, turn, 'call-agent', 'Subagent', 'Inspect the renderer and report back.');

		const start = progress.find(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallStart);
		assert.ok(start?.kind === 'action' && start.action.type === ActionType.ChatToolCallStart);
		assert.deepStrictEqual(start.action._meta, {
			source: 'cli-ts',
			toolKind: 'subagent',
			subagentAgentName: 'worker',
			subagentDescription: 'Inspect the renderer and report back.',
		});
	});

	test('isolated worker metadata remains visible live and after the parent task is reopened', async () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'isolated-worker-history');
		const rootTurn = {
			turnId: 'turn-isolated-worker',
			messageParts: new Map(),
			streamedText: new Map(),
			startedToolCalls: new Set<string>(),
			confirmedToolCalls: new Set<string>(),
			childToolLines: new Map<string, Map<string, string>>(),
			toolSummaries: [] as string[],
			storedParts: [] as Array<{ kind: string; workspace?: unknown }>,
			storedTextParts: new Map(),
			toolInputs: new Map<string, { name: string; input: unknown }>(),
			toolInputSummaries: new Map<string, string>(),
			pendingCompletions: [] as Promise<void>[],
			subagentTurns: new Map(),
			workerWorkspaces: new Map(),
			responseText: '',
			reasoningText: '',
		};
		const session = {
			sessionUri,
			turn: rootTurn,
			storedTurns: [] as unknown[],
			storedSubagentTurns: new Map(),
		};
		const internals = agent as unknown as {
			_sessions: Map<string, unknown>;
			_handleAgentEvent(session: unknown, event: unknown): void;
		};
		internals._sessions.set(AgentSession.id(sessionUri), session);

		internals._handleAgentEvent(session, {
			type: 'tool:requested',
			calls: [{ id: 'agent-isolated', name: 'Agent', input: { name: 'Search', prompt: 'Implement the renderer change.' } }],
		});
		internals._handleAgentEvent(session, {
			type: 'tool:start',
			toolCallId: 'agent-isolated',
			name: 'Agent',
		});
		internals._handleAgentEvent(session, {
			type: 'agent:child_start',
			agentToolCallId: 'agent-isolated',
			childSessionId: 'child-isolated',
			prompt: 'Implement the renderer change.',
			workspace: {
				workerId: 'agent-isolated',
				name: 'Search',
				status: 'Running',
				branch: 'agent/isolated-worker-history/worker/agent-isolated',
				worktreePath: '/repo.backboard-workers/isolated-worker-history/agent-isolated',
				changedFileCount: 0,
				startedAt: '2026-08-25T12:00:00.000Z',
			},
		});
		internals._handleAgentEvent(session, {
			type: 'agent:child_status',
			agentToolCallId: 'agent-isolated',
			workspace: {
				workerId: 'agent-isolated',
				status: 'Running',
				changedFileCount: 1,
				startedAt: '2026-08-25T12:00:00.000Z',
			},
		});
		internals._handleAgentEvent(session, {
			type: 'agent:child_status',
			agentToolCallId: 'agent-isolated',
			workspace: {
				workerId: 'agent-isolated',
				status: 'Running',
				changedFileCount: 2,
				startedAt: '2026-08-25T12:00:00.000Z',
			},
		});
		assert.strictEqual(progress.filter(signal => signal.kind === 'action'
			&& signal.action.type === ActionType.ChatToolCallContentChanged).length, 1, 'Intermediate worker projections should be coalesced to at most 10 Hz');

		internals._handleAgentEvent(session, {
			type: 'agent:child_status',
			agentToolCallId: 'agent-isolated',
			workspace: {
				workerId: 'agent-isolated',
				status: 'Integrated',
				branch: 'agent/isolated-worker-history/worker/agent-isolated',
				worktreePath: '/repo.backboard-workers/isolated-worker-history/agent-isolated',
				changedFileCount: 2,
				startedAt: '2026-08-25T12:00:00.000Z',
				finishedAt: '2026-08-25T12:00:02.000Z',
				integrationResult: 'Integrated as abc123',
			},
		});
		internals._handleAgentEvent(session, {
			type: 'tool:result',
			toolCallId: 'agent-isolated',
			name: 'Agent',
			title: 'Completed in 2 rounds',
		});
		await Promise.allSettled(rootTurn.pendingCompletions);

		const liveUpdate = progress.filter(signal => signal.kind === 'action'
			&& signal.action.type === ActionType.ChatToolCallContentChanged).at(-1);
		assert.ok(liveUpdate?.kind === 'action' && liveUpdate.action.type === ActionType.ChatToolCallContentChanged);
		assert.deepStrictEqual(liveUpdate.action._meta, {
			source: 'cli-ts',
			toolKind: 'subagent',
			subagentAgentName: 'Search',
			subagentDescription: 'Implement the renderer change.',
			subagentWorkerId: 'agent-isolated',
			subagentStatus: 'Integrated',
			subagentChangedFileCount: 2,
			subagentStartedAt: '2026-08-25T12:00:00.000Z',
			subagentFinishedAt: '2026-08-25T12:00:02.000Z',
		});
		assert.strictEqual(rootTurn.storedParts[0]?.workspace && (rootTurn.storedParts[0].workspace as { status?: string }).status, 'Integrated');

		session.storedTurns.push({
			prompt: 'Parallel task',
			response: '',
			parts: rootTurn.storedParts,
		});
		const restored = await agent.getSessionMessages(sessionUri);
		const tool = restored[0]?.responseParts.find((part): part is ToolCallResponsePart => part.kind === ResponsePartKind.ToolCall);
		assert.ok(tool?.toolCall._meta);
		assert.strictEqual(tool.toolCall._meta.subagentStatus, 'Integrated');
		assert.strictEqual(tool.toolCall._meta.subagentAgentName, 'Search');
		const namedStart = progress.find(signal => signal.kind === 'subagent_started');
		assert.ok(namedStart?.kind === 'subagent_started');
		assert.strictEqual(namedStart.agentName, 'Search');
		assert.strictEqual(namedStart.agentDisplayName, 'Search');
		assert.strictEqual(tool.toolCall._meta.subagentBranch, undefined);
		assert.strictEqual(tool.toolCall._meta.subagentWorktreePath, undefined);
		assert.strictEqual(tool.toolCall._meta.subagentIntegrationResult, undefined);
	});

	test('AskUser lifecycle does not emit a tool-call card', () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'ask-user-live');
		const turn = {
			turnId: 'turn-ask-user',
			reasoningPartId: undefined,
			toolInputs: new Map<string, { name: string; input: unknown }>(),
		};
		const session = { sessionUri, turn };
		const internals = agent as unknown as {
			_handleAgentEvent(session: unknown, event: unknown): void;
		};

		internals._handleAgentEvent(session, {
			type: 'tool:requested',
			calls: [{ id: 'call-ask-user', name: 'AskUser', input: { question: 'Pick one' } }],
		});
		for (const event of [
			{ type: 'tool:pending', toolCallId: 'call-ask-user', name: 'AskUser' },
			{ type: 'tool:start', toolCallId: 'call-ask-user', name: 'AskUser' },
			{ type: 'tool:progress', toolCallId: 'call-ask-user', data: 'waiting' },
			{ type: 'tool:result', toolCallId: 'call-ask-user', name: 'AskUser', title: 'Selected: Gameplay tweaks' },
		]) {
			internals._handleAgentEvent(session, event);
		}

		assert.strictEqual(progress.length, 0);
	});

	test('performance timing records never project into parent or child UI', () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'performance-events');
		const internals = agent as unknown as {
			_handleAgentEvent(session: unknown, event: unknown): void;
		};

		internals._handleAgentEvent({ sessionUri, turn: {} }, {
			type: 'performance:timing',
			phase: 'worker_model',
			durationMs: 123.4,
			toolCallId: 'agent-performance',
			workerId: 'worker-performance',
		});

		assert.deepStrictEqual(progress, []);
	});

	test('worker events stream into a reopenable child chat', async () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'worker-parent');
		const rootTurn = {
			turnId: 'turn-parent',
			messageParts: new Map(),
			streamedText: new Map(),
			startedToolCalls: new Set(),
			confirmedToolCalls: new Set(),
			childToolLines: new Map(),
			toolSummaries: [],
			storedParts: [],
			storedTextParts: new Map(),
			toolInputs: new Map(),
			toolInputSummaries: new Map(),
			pendingCompletions: [] as Promise<void>[],
			subagentTurns: new Map(),
			responseText: '',
			reasoningText: '',
		};
		const session = {
			sessionUri,
			turn: rootTurn,
			storedSubagentTurns: new Map(),
		};
		const internals = agent as unknown as {
			_sessions: Map<string, unknown>;
			_handleAgentEvent(session: unknown, event: unknown): void;
		};
		internals._sessions.set(AgentSession.id(sessionUri), session);

		internals._handleAgentEvent(session, {
			type: 'agent:child_start',
			agentToolCallId: 'agent-call-1',
			childSessionId: 'child-turn-1',
			prompt: 'Inspect the renderer and report what it does.',
		});
		internals._handleAgentEvent(session, {
			type: 'agent:child_event',
			agentToolCallId: 'agent-call-1',
			event: { type: 'assistant:delta', turnId: 'child-turn-1', messageId: 'child-message-1', text: 'The renderer groups tool calls.' },
		});
		internals._handleAgentEvent(session, {
			type: 'agent:child_end',
			agentToolCallId: 'agent-call-1',
			status: 'completed',
		});
		await Promise.allSettled(rootTurn.pendingCompletions);

		const started = progress.find(signal => signal.kind === 'subagent_started');
		assert.ok(started?.kind === 'subagent_started');
		assert.strictEqual(started.prompt, 'Inspect the renderer and report what it does.');
		assert.ok(progress.some(signal => signal.kind === 'action'
			&& signal.parentToolCallId === 'agent-call-1'
			&& signal.action.type === ActionType.ChatTurnStarted));
		assert.ok(progress.some(signal => signal.kind === 'action' && signal.parentToolCallId === 'agent-call-1' && signal.action.type === ActionType.ChatDelta));
		assert.ok(progress.some(signal => signal.kind === 'action'
			&& signal.parentToolCallId === 'agent-call-1'
			&& signal.action.type === ActionType.ChatTurnComplete));
		assert.ok(progress.some(signal => signal.kind === 'subagent_completed'));

		const childUri = URI.parse(buildSubagentSessionUri(sessionUri.toString(), 'agent-call-1'));
		const turns = await agent.getSessionMessages(childUri);
		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].message.text, 'Inspect the renderer and report what it does.');
		assert.strictEqual(turns[0].responseParts[0]?.kind, ResponsePartKind.Markdown);
		if (turns[0].responseParts[0]?.kind === ResponsePartKind.Markdown) {
			assert.strictEqual(turns[0].responseParts[0].content, 'The renderer groups tool calls.');
		}
	});

	test('streamed write workers remain queued until execution actually starts', () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'worker-pending');
		const session = {
			sessionUri,
			turn: {
				turnId: 'turn-worker-pending',
				messageParts: new Map(),
				streamedText: new Map(),
				startedToolCalls: new Set(),
				confirmedToolCalls: new Set(),
				childToolLines: new Map(),
				toolSummaries: [],
				storedParts: [],
				storedTextParts: new Map(),
				toolInputs: new Map(),
				toolInputSummaries: new Map(),
				pendingCompletions: [] as Promise<void>[],
				subagentTurns: new Map(),
				responseText: '',
				reasoningText: '',
			},
		};
		const internals = agent as unknown as {
			_handleAgentEvent(session: unknown, event: unknown): void;
		};

		internals._handleAgentEvent(session, {
			type: 'tool:pending',
			toolCallId: 'agent-call-pending',
			name: 'Agent',
			inputSummary: 'Build the renderer module.',
		});
		assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_started').length, 0);
		assert.strictEqual(progress.filter(signal => signal.kind === 'action').length, 0);

		internals._handleAgentEvent(session, {
			type: 'tool:start',
			toolCallId: 'agent-call-pending',
			name: 'Agent',
			inputSummary: 'Build the renderer module.',
		});
		assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_started').length, 1);
	});

	test('worker file edits stay attached to the live and reopened child chat', async () => {
		const agent = createAgent();
		const sessionUri = AgentSession.uri('backboard', 'worker-edit-history');
		const rootTurn = {
			turnId: 'turn-parent-edit',
			messageParts: new Map(),
			streamedText: new Map(),
			startedToolCalls: new Set(),
			confirmedToolCalls: new Set(),
			childToolLines: new Map(),
			toolSummaries: [],
			storedParts: [],
			storedTextParts: new Map(),
			toolInputs: new Map(),
			toolInputSummaries: new Map(),
			pendingCompletions: [] as Promise<void>[],
			subagentTurns: new Map(),
			responseText: '',
			reasoningText: '',
		};
		const session = {
			sessionUri,
			turn: rootTurn,
			storedTurns: [],
			storedSubagentTurns: new Map(),
		};
		const fileEdit: ToolResultFileEditContent = {
			type: ToolResultContentType.FileEdit,
			before: { uri: URI.file('/workspace/renderer.ts').toString(), content: { uri: 'session-db://before' } },
			after: { uri: URI.file('/workspace/renderer.ts').toString(), content: { uri: 'session-db://after' } },
			diff: { added: 2, removed: 1 },
		};
		const internals = agent as unknown as {
			_sessions: Map<string, unknown>;
			_handleAgentEvent(session: unknown, event: unknown): void;
			_buildFileEditContents(): Promise<ToolResultFileEditContent[]>;
		};
		internals._sessions.set(AgentSession.id(sessionUri), session);
		internals._buildFileEditContents = async () => [fileEdit];

		internals._handleAgentEvent(session, {
			type: 'agent:child_start',
			agentToolCallId: 'agent-call-edit',
			childSessionId: 'child-turn-edit',
			prompt: 'Update the renderer.',
		});
		internals._handleAgentEvent(session, {
			type: 'agent:child_event',
			agentToolCallId: 'agent-call-edit',
			event: { type: 'tool:requested', calls: [{ id: 'child-edit', name: 'Edit', input: { file_path: '/workspace/renderer.ts' } }] },
		});
		internals._handleAgentEvent(session, {
			type: 'agent:child_event',
			agentToolCallId: 'agent-call-edit',
			event: { type: 'tool:start', toolCallId: 'child-edit', name: 'Edit', inputSummary: '/workspace/renderer.ts' },
		});
		internals._handleAgentEvent(session, {
			type: 'agent:child_event',
			agentToolCallId: 'agent-call-edit',
			event: {
				type: 'tool:result',
				toolCallId: 'child-edit',
				name: 'Edit',
				title: 'Updated renderer.ts',
				fileEdits: [{ path: '/workspace/renderer.ts', before: 'old', after: 'new' }],
			},
		});
		internals._handleAgentEvent(session, {
			type: 'agent:child_end',
			agentToolCallId: 'agent-call-edit',
			status: 'completed',
		});
		await Promise.allSettled(rootTurn.pendingCompletions);

		const childUri = URI.parse(buildSubagentSessionUri(sessionUri.toString(), 'agent-call-edit'));
		const turns = await agent.getSessionMessages(childUri);
		const tool = turns[0]?.responseParts.find((part): part is ToolCallResponsePart => part.kind === ResponsePartKind.ToolCall);
		assert.strictEqual(tool?.toolCall.toolCallId, 'child-edit');
		assert.strictEqual(tool?.toolCall.status, ToolCallStatus.Completed);
		if (!tool || tool.toolCall.status !== ToolCallStatus.Completed) {
			assert.fail('Expected a completed child edit tool');
		}
		assert.deepStrictEqual(tool.toolCall.content?.filter(content => content.type === ToolResultContentType.FileEdit), [fileEdit]);
	});

	test('parent tool completion finalizes a child when child_end is missing', async () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'worker-fallback');
		const rootTurn = {
			turnId: 'turn-parent-fallback',
			messageParts: new Map(),
			streamedText: new Map(),
			startedToolCalls: new Set(),
			confirmedToolCalls: new Set(),
			childToolLines: new Map(),
			toolSummaries: [],
			storedParts: [],
			storedTextParts: new Map(),
			toolInputs: new Map(),
			toolInputSummaries: new Map(),
			pendingCompletions: [] as Promise<void>[],
			subagentTurns: new Map(),
			responseText: '',
			reasoningText: '',
		};
		const session = {
			sessionUri,
			turn: rootTurn,
			storedSubagentTurns: new Map(),
		};
		const internals = agent as unknown as {
			_sessions: Map<string, unknown>;
			_handleAgentEvent(session: unknown, event: unknown): void;
		};
		internals._sessions.set(AgentSession.id(sessionUri), session);

		internals._handleAgentEvent(session, {
			type: 'agent:child_start',
			agentToolCallId: 'agent-call-fallback',
			childSessionId: 'child-turn-fallback',
			prompt: 'Check whether the renderer can stall.',
		});
		internals._handleAgentEvent(session, {
			type: 'agent:child_event',
			agentToolCallId: 'agent-call-fallback',
			event: { type: 'assistant:delta', turnId: 'child-turn-fallback', messageId: 'child-message-fallback', text: 'No stall found.' },
		});
		internals._handleAgentEvent(session, {
			type: 'tool:result',
			toolCallId: 'agent-call-fallback',
			name: 'Subagent',
			title: 'Subagent finished',
		});
		await Promise.allSettled(rootTurn.pendingCompletions);

		internals._handleAgentEvent(session, {
			type: 'agent:child_end',
			agentToolCallId: 'agent-call-fallback',
			status: 'completed',
		});
		await Promise.allSettled(rootTurn.pendingCompletions);

		const childCompletions = progress.filter(signal => signal.kind === 'action'
			&& signal.parentToolCallId === 'agent-call-fallback'
			&& signal.action.type === ActionType.ChatTurnComplete);
		assert.strictEqual(childCompletions.length, 1, 'Fallback and late child_end must finalize exactly once');
		assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_completed').length, 1);
		const childUri = URI.parse(buildSubagentSessionUri(sessionUri.toString(), 'agent-call-fallback'));
		const turns = await agent.getSessionMessages(childUri);
		assert.strictEqual(turns[0]?.responseParts[0]?.kind, ResponsePartKind.Markdown);
	});

	test('parent finalization cancels unfinished blocking children but preserves detached workers', async () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'worker-parent-cancel');
		const rootTurn = {
			turnId: 'turn-parent-cancel',
			prompt: 'Run both workers',
			messageParts: new Map(), streamedText: new Map(), startedToolCalls: new Set<string>(), confirmedToolCalls: new Set<string>(),
			childToolLines: new Map(), toolSummaries: [] as string[], storedParts: [], storedTextParts: new Map(),
			toolInputs: new Map<string, { name: string; input: unknown }>([
				['agent-blocking', { name: 'Agent', input: { prompt: 'Blocking work' } }],
				['agent-detached', { name: 'AgentSpawn', input: { prompt: 'Detached work' } }],
			]),
			toolInputSummaries: new Map(), mutationBatches: new Map(), toolUi: new Map(), terminalOutputs: new Map(),
			pendingCompletions: [] as Promise<void>[], subagentTurns: new Map(), workerWorkspaces: new Map(), responseText: '', reasoningText: '',
		};
		const session = {
			sessionId: 'worker-parent-cancel', sessionUri, turn: rootTurn, storedTurns: [], storedSubagentTurns: new Map(),
			subagentTurnOwners: new Map(), completedSubagentToolCallIds: new Set(), pendingInputs: new Map(), pendingClientToolCalls: new Set(),
			modifiedAt: Date.now(), createdAt: Date.now(), materialized: true,
		};
		const internals = agent as unknown as {
			_sessions: Map<string, unknown>;
			_ensureSubagentTurn(session: unknown, turn: unknown, toolCallId: string, prompt: string): { completion?: Promise<void> };
			_cancelUnfinishedSubagents(session: unknown, turn: unknown, includeDetached: boolean): void;
		};
		internals._sessions.set(AgentSession.id(sessionUri), session);
		const blocking = internals._ensureSubagentTurn(session, rootTurn, 'agent-blocking', 'Blocking work');
		const detached = internals._ensureSubagentTurn(session, rootTurn, 'agent-detached', 'Detached work');

		internals._cancelUnfinishedSubagents(session, rootTurn, false);
		await Promise.allSettled(rootTurn.pendingCompletions);

		assert.ok(blocking.completion, 'The blocking child must reach a durable terminal state');
		assert.strictEqual(detached.completion, undefined, 'AgentSpawn must remain live after its parent provider turn');
		assert.ok(progress.some(signal => signal.kind === 'action'
			&& signal.parentToolCallId === 'agent-blocking'
			&& signal.action.type === ActionType.ChatTurnCancelled));
		assert.strictEqual(progress.some(signal => signal.kind === 'action'
			&& signal.parentToolCallId === 'agent-detached'
			&& signal.action.type === ActionType.ChatTurnCancelled), false);
		assert.strictEqual(session.subagentTurnOwners.has('agent-blocking'), false);
		assert.strictEqual(session.subagentTurnOwners.has('agent-detached'), true);
	});

	test('session disposal fallback cancels an unfinished AgentSpawn child', async () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'detached-worker-stop');
		const rootTurn = {
			turnId: 'turn-detached-stop',
			prompt: 'Spawn then stop',
			messageParts: new Map(), streamedText: new Map(), startedToolCalls: new Set<string>(), confirmedToolCalls: new Set<string>(),
			childToolLines: new Map(), toolSummaries: [] as string[], storedParts: [], storedTextParts: new Map(),
			toolInputs: new Map<string, { name: string; input: unknown }>([
				['agent-detached', { name: 'AgentSpawn', input: { prompt: 'Detached work' } }],
			]),
			toolInputSummaries: new Map(), mutationBatches: new Map(), toolUi: new Map(), terminalOutputs: new Map(),
			pendingCompletions: [] as Promise<void>[], subagentTurns: new Map(), workerWorkspaces: new Map(), responseText: '', reasoningText: '',
		};
		const session = {
			sessionId: 'detached-worker-stop', sessionUri, turn: rootTurn, storedTurns: [], storedSubagentTurns: new Map(),
			subagentTurnOwners: new Map(), completedSubagentToolCallIds: new Set(), pendingInputs: new Map(), pendingClientToolCalls: new Set(),
			modifiedAt: Date.now(), createdAt: Date.now(), materialized: true,
		};
		const internals = agent as unknown as {
			_sessions: Map<string, unknown>;
			_ensureSubagentTurn(session: unknown, turn: unknown, toolCallId: string, prompt: string): { completion?: Promise<void> };
			_cancelUnfinishedSubagents(session: unknown, turn: unknown, includeDetached: boolean): void;
		};
		internals._sessions.set(AgentSession.id(sessionUri), session);
		const detached = internals._ensureSubagentTurn(session, rootTurn, 'agent-detached', 'Detached work');

		internals._cancelUnfinishedSubagents(session, rootTurn, true);
		await Promise.allSettled(rootTurn.pendingCompletions);

		assert.ok(detached.completion, 'disposal must create a durable terminal completion when no later event can arrive');
		assert.ok(progress.some(signal => signal.kind === 'action'
			&& signal.parentToolCallId === 'agent-detached'
			&& signal.action.type === ActionType.ChatTurnCancelled));
		assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_completed').length, 1);
		assert.strictEqual(session.subagentTurnOwners.has('agent-detached'), false, 'a cancelled detached owner must not leak');
		assert.strictEqual(session.completedSubagentToolCallIds.has('agent-detached'), true);
	});

	test('rejected AgentSpawn fails durably after its parent turn is released', async () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'detached-worker-rejected');
		const rootTurn = {
			turnId: 'turn-detached-rejected', prompt: 'Spawn in a dirty checkout',
			messageParts: new Map(), streamedText: new Map(), startedToolCalls: new Set<string>(), confirmedToolCalls: new Set<string>(),
			childToolLines: new Map(), toolSummaries: [] as string[], storedParts: [], storedTextParts: new Map(),
			toolInputs: new Map<string, { name: string; input: unknown }>(), toolInputSummaries: new Map(), mutationBatches: new Map(),
			toolUi: new Map(), terminalOutputs: new Map(), pendingCompletions: [] as Promise<void>[], subagentTurns: new Map(),
			workerWorkspaces: new Map(), responseText: '', reasoningText: '',
		};
		const session = {
			sessionId: 'detached-worker-rejected', sessionUri, turn: rootTurn as typeof rootTurn | undefined,
			storedTurns: [] as Array<{ prompt: string; response: string; parts?: readonly unknown[] }>, storedSubagentTurns: new Map(),
			subagentTurnOwners: new Map(), completedSubagentToolCallIds: new Set(), pendingInputs: new Map(), pendingClientToolCalls: new Set(),
			modifiedAt: Date.now(), createdAt: Date.now(), materialized: true,
		};
		const internals = agent as unknown as {
			_sessions: Map<string, unknown>;
			_handleAgentEvent(session: unknown, event: unknown): void;
			_readRuntimeSubagentRecovery(): Promise<undefined>;
		};
		internals._sessions.set(AgentSession.id(sessionUri), session);
		internals._readRuntimeSubagentRecovery = async () => undefined;
		internals._handleAgentEvent(session, {
			type: 'tool:requested', calls: [{ id: 'spawn-rejected', name: 'AgentSpawn', input: { prompt: 'Implement the task.' } }],
		});
		internals._handleAgentEvent(session, {
			type: 'tool:start', toolCallId: 'spawn-rejected', name: 'AgentSpawn', inputSummary: 'Implement the task.',
		});
		internals._handleAgentEvent(session, {
			type: 'tool:result', toolCallId: 'spawn-rejected', name: 'AgentSpawn', title: 'Worker started',
		});
		await Promise.allSettled(rootTurn.pendingCompletions);
		session.storedTurns.push({ prompt: rootTurn.prompt, response: '', parts: rootTurn.storedParts });
		session.turn = undefined;

		internals._handleAgentEvent(session, {
			type: 'agent:child_end', agentToolCallId: 'spawn-rejected', status: 'failed',
		});
		await Promise.allSettled(rootTurn.pendingCompletions);

		assert.deepStrictEqual(failureNotes(progress.filter(signal => signal.kind === 'action' && signal.parentToolCallId === 'spawn-rejected')), [
			'_This subagent stopped early and handed its task back to the main agent._',
		]);
		assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_completed').length, 1);
		assert.strictEqual(session.subagentTurnOwners.has('spawn-rejected'), false);
		assert.strictEqual(session.completedSubagentToolCallIds.has('spawn-rejected'), true);
	});

	test('AgentSpawn stays detached until late child lifecycle completes its owning turn', async () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'detached-worker-owner');
		const createTurn = (turnId: string, prompt: string) => ({
			turnId,
			prompt,
			messageParts: new Map(),
			streamedText: new Map(),
			startedToolCalls: new Set<string>(),
			confirmedToolCalls: new Set<string>(),
			childToolLines: new Map(),
			toolSummaries: [] as string[],
			storedParts: [] as Array<{ kind: string; id?: string; name?: string; workspace?: unknown }>,
			storedTextParts: new Map(),
			toolInputs: new Map<string, { name: string; input: unknown }>(),
			toolInputSummaries: new Map<string, string>(),
			toolUi: new Map(),
			terminalOutputs: new Map(),
			pendingCompletions: [] as Promise<void>[],
			subagentTurns: new Map<string, { completion?: Promise<void> }>(),
			workerWorkspaces: new Map(),
			responseText: '',
			reasoningText: '',
		});
		const ownerTurn = createTurn('turn-detached-owner', 'Spawn a worker.');
		const session = {
			sessionUri,
			sessionId: AgentSession.id(sessionUri),
			turn: ownerTurn,
			storedTurns: [] as Array<{ prompt: string; response: string; parts?: readonly unknown[] }>,
			storedSubagentTurns: new Map(),
			subagentTurnOwners: new Map(),
			modifiedAt: 0,
		};
		let durableFlushes = 0;
		const internals = agent as unknown as {
			_sessions: Map<string, unknown>;
			_handleAgentEvent(session: unknown, event: unknown): void;
			_writeStore(): void;
			_readRuntimeSubagentRecovery(): Promise<undefined>;
		};
		internals._sessions.set(AgentSession.id(sessionUri), session);
		internals._writeStore = () => { durableFlushes++; };
		internals._readRuntimeSubagentRecovery = async () => undefined;

		internals._handleAgentEvent(session, {
			type: 'tool:requested',
			calls: [
				{ id: 'spawn-1', name: 'AgentSpawn', input: { prompt: 'Inspect the detached renderer.' } },
				{ id: 'wait-1', name: 'AgentWait', input: { handles: ['spawn-1'] } },
			],
		});
		internals._handleAgentEvent(session, {
			type: 'tool:start',
			toolCallId: 'spawn-1',
			name: 'AgentSpawn',
			inputSummary: 'Inspect the detached renderer.',
		});
		internals._handleAgentEvent(session, {
			type: 'tool:result',
			toolCallId: 'spawn-1',
			name: 'AgentSpawn',
			title: 'Worker started',
			detail: 'Worker started with handle spawn-1.',
		});
		internals._handleAgentEvent(session, {
			type: 'agent:child_status',
			agentToolCallId: 'spawn-1',
			workspace: {
				workerId: 'spawn-1', status: 'Running', changedFileCount: 0,
				startedAt: '2026-09-01T12:00:00.000Z',
			},
		});
		internals._handleAgentEvent(session, {
			type: 'tool:start',
			toolCallId: 'wait-1',
			name: 'AgentWait',
			inputSummary: 'spawn-1',
		});
		internals._handleAgentEvent(session, {
			type: 'tool:result',
			toolCallId: 'wait-1',
			name: 'AgentWait',
			title: '0/1 workers finished',
		});
		await Promise.allSettled(ownerTurn.pendingCompletions);

		assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_started').length, 1, 'AgentWait must not create another child');
		assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_completed').length, 0, 'AgentSpawn handle delivery must not complete the child');
		assert.ok(ownerTurn.subagentTurns.has('spawn-1'));
		assert.ok(!ownerTurn.subagentTurns.has('wait-1'));
		const spawnComplete = progress.find(signal => signal.kind === 'action'
			&& signal.action.type === ActionType.ChatToolCallComplete
			&& signal.action.toolCallId === 'spawn-1');
		assert.strictEqual(spawnComplete, undefined, 'successful handle delivery keeps the frontend launcher active');

		// The provider turn is now historical and an unrelated next turn is active.
		// Detached child events must retain the original owner rather than attach to
		// the newer turn or disappear when session.turn changes.
		session.storedTurns.push({ prompt: ownerTurn.prompt, response: '', parts: ownerTurn.storedParts });
		const nextTurn = createTurn('turn-after-spawn', 'Continue unrelated work.');
		session.turn = nextTurn;
		internals._handleAgentEvent(session, {
			type: 'agent:child_event',
			agentToolCallId: 'spawn-1',
			event: { type: 'assistant:delta', turnId: 'child-detached', messageId: 'detached-answer', text: 'Detached work finished.' },
		});
		internals._handleAgentEvent(session, {
			type: 'agent:child_end',
			agentToolCallId: 'spawn-1',
			// Simulate the adversarial Stop/capture ordering: durable workspace
			// integration is authoritative over an older provisional cancellation.
			status: 'cancelled',
		});
		assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_completed').length, 0, 'a provisional child end waits for workspace authority');
		internals._handleAgentEvent(session, {
			type: 'agent:child_status',
			agentToolCallId: 'spawn-1',
			workspace: {
				workerId: 'spawn-1',
				status: 'Integrated',
				changedFileCount: 2,
				startedAt: '2026-09-01T12:00:00.000Z',
				finishedAt: '2026-09-01T12:00:01.000Z',
			},
		});
		await Promise.allSettled(ownerTurn.pendingCompletions);

		assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_completed').length, 1);
		const finalSpawnComplete = progress.find(signal => signal.kind === 'action'
			&& signal.action.type === ActionType.ChatToolCallComplete && signal.action.toolCallId === 'spawn-1');
		assert.ok(finalSpawnComplete?.kind === 'action' && finalSpawnComplete.action.type === ActionType.ChatToolCallComplete);
		assert.strictEqual(finalSpawnComplete.action._meta?.subagentDetached, true);
		assert.ok(progress.some(signal => signal.kind === 'action'
			&& signal.parentToolCallId === 'spawn-1'
			&& signal.action.type === ActionType.ChatTurnComplete));
		assert.strictEqual(progress.some(signal => signal.kind === 'action'
			&& signal.parentToolCallId === 'spawn-1'
			&& signal.action.type === ActionType.ChatTurnCancelled), false, 'integrated workspace authority must win the Stop race');
		assert.strictEqual(ownerTurn.storedParts.find(part => part.id === 'spawn-1')?.workspace
			&& (ownerTurn.storedParts.find(part => part.id === 'spawn-1')?.workspace as { status?: string }).status, 'Integrated');
		assert.strictEqual(nextTurn.workerWorkspaces.size, 0, 'late status must not attach to the next provider turn');
		assert.ok(durableFlushes >= 2, 'terminal status and child completion should both be durable lifecycle boundaries');
		internals._handleAgentEvent(session, {
			type: 'agent:child_status',
			agentToolCallId: 'spawn-1',
			workspace: {
				workerId: 'spawn-1',
				status: 'Integrated',
				changedFileCount: 2,
				startedAt: '2026-09-01T12:00:00.000Z',
				finishedAt: '2026-09-01T12:00:01.000Z',
			},
		});
		assert.strictEqual(nextTurn.subagentTurns.size, 0, 'a duplicate terminal event must not create a child on the next turn');
		assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_started').length, 1);

		const childUri = URI.parse(buildSubagentSessionUri(sessionUri.toString(), 'spawn-1'));
		const childTurns = await agent.getSessionMessages(childUri);
		assert.strictEqual(childTurns[0]?.responseParts[0]?.kind, ResponsePartKind.Markdown);
		if (childTurns[0]?.responseParts[0]?.kind === ResponsePartKind.Markdown) {
			assert.strictEqual(childTurns[0].responseParts[0].content, 'Detached work finished.');
		}
	});

	test('agent_spawn stays detached when lifecycle events use the Subagent display name', async () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'detached-display-name');
		const ownerTurn = {
			turnId: 'turn-display-name', prompt: 'Spawn a worker.', messageParts: new Map(), streamedText: new Map(),
			startedToolCalls: new Set<string>(), confirmedToolCalls: new Set<string>(), childToolLines: new Map(),
			toolSummaries: [] as string[], storedParts: [] as unknown[], storedTextParts: new Map(),
			toolInputs: new Map<string, { name: string; input: unknown }>(), toolInputSummaries: new Map<string, string>(),
			toolUi: new Map(), terminalOutputs: new Map(), pendingCompletions: [] as Promise<void>[],
			subagentTurns: new Map<string, { completion?: Promise<void> }>(), workerWorkspaces: new Map(), responseText: '', reasoningText: '',
		};
		const session = {
			sessionUri, sessionId: AgentSession.id(sessionUri), turn: ownerTurn, storedTurns: [],
			storedSubagentTurns: new Map(), subagentTurnOwners: new Map(), modifiedAt: 0,
		};
		const internals = agent as unknown as {
			_sessions: Map<string, unknown>;
			_handleAgentEvent(session: unknown, event: unknown): void;
			_writeStore(): void;
			_readRuntimeSubagentRecovery(): Promise<undefined>;
		};
		internals._sessions.set(AgentSession.id(sessionUri), session);
		internals._writeStore = () => { };
		internals._readRuntimeSubagentRecovery = async () => undefined;

		// cli-ts reports the provider call as `agent_spawn`, but every lifecycle
		// event carries AgentSpawnTool's display name, `Subagent`.
		internals._handleAgentEvent(session, { type: 'tool:requested', calls: [{ id: 'spawn-display', name: 'agent_spawn', input: { name: 'BackgroundWorker', prompt: 'Run a command.' } }] });
		internals._handleAgentEvent(session, { type: 'tool:start', toolCallId: 'spawn-display', name: 'Subagent', inputSummary: 'Run a command.' });
		internals._handleAgentEvent(session, { type: 'tool:result', toolCallId: 'spawn-display', name: 'Subagent', title: 'Worker queued' });
		await Promise.allSettled(ownerTurn.pendingCompletions);
		internals._handleAgentEvent(session, {
			type: 'agent:child_event', agentToolCallId: 'spawn-display',
			event: { type: 'assistant:delta', turnId: 'child-display', messageId: 'child-answer', text: 'Worker report.' },
		});

		const actions = progress.flatMap(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallStart && signal.action.toolCallId === 'spawn-display' ? [signal.action] : []);
		assert.deepStrictEqual({
			startDetached: actions[0]?._meta?.subagentDetached,
			launcherCompleted: progress.some(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallComplete && signal.action.toolCallId === 'spawn-display'),
			childCompleted: progress.some(signal => signal.kind === 'subagent_completed'),
			childDeltaRouted: progress.some(signal => signal.kind === 'action' && signal.parentToolCallId === 'spawn-display' && signal.action.type === ActionType.ChatResponsePart),
		}, { startDetached: true, launcherCompleted: false, childCompleted: false, childDeltaRouted: true });
	});

	test('isolated child edits remain proposals until integration and recovery preserves failure', async () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'isolated-edit-gate');
		const workspace = { status: 'Running', worktreePath: '/private/worker', workerId: 'worker', changedFileCount: 1 };
		const owner = { workerWorkspaces: new Map([['worker', workspace]]) };
		const session = { sessionUri, subagentTurnOwners: new Map([['worker', owner]]) };
		const childTurn = {
			turnId: 'child-turn', messageParts: new Map(), streamedText: new Map(),
			startedToolCalls: new Set(), confirmedToolCalls: new Set(), childToolLines: new Map(),
			toolSummaries: [], storedParts: [], storedTextParts: new Map(), toolInputs: new Map(),
			toolInputSummaries: new Map(), toolUi: new Map(), terminalOutputs: new Map(),
			pendingCompletions: [] as Promise<void>[], subagentTurns: new Map(), workerWorkspaces: new Map(),
			responseText: '', reasoningText: '',
		};
		const fileEdit: ToolResultFileEditContent = {
			type: ToolResultContentType.FileEdit,
			before: { uri: URI.file('/repo/file.ts').toString(), content: { uri: 'session-db://before' } },
			after: { uri: URI.file('/repo/file.ts').toString(), content: { uri: 'session-db://after' } },
			diff: { added: 1, removed: 1 },
		};
		const internals = agent as unknown as {
			_handleMappedAgentEvent(session: unknown, event: unknown, turn: unknown, parentToolCallId: string): void;
			_attachRuntimeRecoveryFileEdits(session: unknown, turn: unknown, recovery: unknown, parentToolCallId: string): Promise<void>;
			_buildFileEditContents(): Promise<ToolResultFileEditContent[]>;
		};
		let recordedEdits = 0;
		internals._buildFileEditContents = async () => { recordedEdits++; return [fileEdit]; };
		for (const status of ['Running', 'Completed', 'Integrating', 'Conflict', 'Cancelled', 'Failed', 'Integrated']) {
			workspace.status = status;
			internals._handleMappedAgentEvent(session, {
				type: 'tool:result', toolCallId: `write-${status}`, name: 'Write', title: 'Wrote file',
				fileEdits: [{ path: '/repo/file.ts', before: 'before', after: 'after' }],
			}, childTurn, 'worker');
			await Promise.all(childTurn.pendingCompletions);
			const completion = progress.findLast(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallComplete);
			assert.ok(completion?.kind === 'action' && completion.action.type === ActionType.ChatToolCallComplete);
			if (completion?.kind === 'action' && completion.action.type === ActionType.ChatToolCallComplete) {
				assert.strictEqual(completion.action.result.content?.some(content => content.type === ToolResultContentType.FileEdit) ?? false, status === 'Integrated');
			}
		}
		assert.strictEqual(recordedEdits, 1, 'only integrated edits enter the coordinator tracker');
		await internals._attachRuntimeRecoveryFileEdits(session, childTurn, {
			turn: { prompt: 'Edit', response: '', parts: [{ kind: 'tool', id: 'failed-edit', name: 'Edit', failed: true }] },
			fileEdits: [{ toolCallId: 'failed-edit', toolName: 'Edit', toolInput: {}, title: 'Partially edited before failure', edits: [{ path: '/repo/file.ts', before: 'before', after: 'partial' }] }],
		}, 'worker');
		const failed = progress.findLast(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallComplete);
		assert.ok(failed?.kind === 'action' && failed.action.type === ActionType.ChatToolCallComplete);
		if (failed?.kind === 'action' && failed.action.type === ActionType.ChatToolCallComplete) {
			assert.strictEqual(failed.action.result.success, false);
			assert.deepStrictEqual(failed.action.result.content?.filter(content => content.type === ToolResultContentType.FileEdit), [fileEdit]);
		}
	});

	test('authoritative batch children reject stale revisions and complete independently after durable results', async () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'batch-revisions');
		const turn = {
			turnId: 'batch-turn', prompt: 'Delegate independent tasks', messageParts: new Map(), streamedText: new Map(),
			startedToolCalls: new Set(), confirmedToolCalls: new Set(), childToolLines: new Map(), toolSummaries: [],
			storedParts: [] as Array<{ kind: string; id?: string; workspace?: { status: string }; worker?: CliTsWorkerState }>,
			storedTextParts: new Map(), toolInputs: new Map(), toolInputSummaries: new Map(), toolUi: new Map(), terminalOutputs: new Map(),
			pendingCompletions: [] as Promise<void>[], subagentTurns: new Map(), workerWorkspaces: new Map(), responseText: '', reasoningText: '',
		};
		const session = { sessionId: 'batch-revisions', sessionUri, turn: turn as typeof turn | undefined, storedTurns: [{ prompt: turn.prompt, response: '', parts: turn.storedParts }], storedSubagentTurns: new Map(), subagentTurnOwners: new Map(), completedSubagentToolCallIds: new Set() };
		const internals = agent as unknown as { _sessions: Map<string, unknown>; _writeStore(): void; _readRuntimeSubagentRecovery(): Promise<unknown>; _handleAgentEvent(session: unknown, event: CliTsAgentEvent): void };
		internals._sessions.set('batch-revisions', session);
		internals._writeStore = () => { };
		internals._readRuntimeSubagentRecovery = async () => ({ turn: { prompt: 'Worker task', response: 'Recorded child answer' }, fileEdits: [{ toolCallId: 'private-write', toolName: 'Write', toolInput: {}, edits: [{ path: '/repo/shared.txt', before: 'Private base', after: 'Private proposal' }] }], isolatedWorkspace: true, workerIntegrationStatus: 'integrated' });
		const worker = (handle: string, revision: number, overrides: Partial<CliTsWorkerState> = {}): CliTsWorkerState => ({ handle, sessionId: 'batch-revisions', prompt: `Work on ${handle}`, name: handle, revision, executionStatus: 'queued', integrationStatus: 'not_required', status: 'queued', readOnly: true, createdAt: '2026-09-05T12:00:00Z', ...overrides });
		const update = (state: CliTsWorkerState) => internals._handleAgentEvent(session, { type: 'agent:worker_update', agentToolCallId: state.handle, parentBatchToolCallId: 'batch-call', worker: state });
		update(worker('Alpha', 1));
		update(worker('Beta', 1));
		update(worker('Gamma', 1));
		update(worker('Alpha', 3, { executionStatus: 'running', status: 'running' }));
		update(worker('Alpha', 2, { executionStatus: 'failed', status: 'failed', error: 'Stale failure' }));
		update(worker('Alpha', 3, { executionStatus: 'failed', status: 'failed', error: 'Contradictory duplicate' }));
		update(worker('Alpha', 4, { sessionId: 'other-session', executionStatus: 'failed', status: 'failed' }));
		internals._handleAgentEvent(session, { type: 'agent:child_status', agentToolCallId: 'Alpha', workspace: { workerId: 'Alpha', status: 'Failed', changedFileCount: 0, startedAt: '2026-09-05T12:00:00Z' } });
		update(worker('Beta', 2, { status: 'running', executionStatus: 'completed', integrationStatus: 'integrated', readOnly: false }));
		internals._handleAgentEvent(session, { type: 'agent:child_end', agentToolCallId: 'Beta', status: 'completed' });
		assert.deepStrictEqual(turn.storedParts.map(part => [part.id, part.worker?.revision, part.workspace?.status]), [['Alpha', 3, 'Running'], ['Beta', 2, 'Integrating'], ['Gamma', 1, 'Queued']]);
		assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_completed').length, 0);
		// Finishing the parent/batch does not finish any of its individual handles.
		session.turn = undefined;
		update(worker('Alpha', 4, { status: 'completed', executionStatus: 'completed' }));
		update(worker('Beta', 3, { status: 'completed', executionStatus: 'completed', integrationStatus: 'integrated', readOnly: false, persistenceError: 'Could not save worker result' }));
		update(worker('Gamma', 2, { status: 'cancelled', executionStatus: 'cancelled' }));
		await Promise.allSettled(turn.pendingCompletions);
		update(worker('Alpha', 3, { status: 'running', executionStatus: 'running' }));
		assert.deepStrictEqual(progress.filter(signal => signal.kind === 'subagent_started').map(signal => signal.toolCallId), ['Alpha', 'Beta', 'Gamma']);
		assert.deepStrictEqual(progress.filter(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallComplete).map(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallComplete ? [signal.action.toolCallId, signal.action.result.success] : undefined), [['Alpha', true], ['Beta', false], ['Gamma', false]]);
		assert.strictEqual(progress.some(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallStart && signal.action.toolName === 'apply_worker_changes'), false, 'Modern missing exact records must not publish private proposals');
		const beta = await agent.getSessionMessages(URI.parse(buildSubagentSessionUri(sessionUri.toString(), 'Beta')));
		assert.deepStrictEqual([beta[0]?.state, beta[0]?.error, failureNote(beta[0])], [TurnState.Complete, undefined, '_This subagent stopped early and handed its task back to the main agent._']);
		const parent = await agent.getSessionMessages(sessionUri);
		assert.deepStrictEqual(parent[0].responseParts.filter(part => part.kind === ResponsePartKind.ToolCall).map(part => part.kind === ResponsePartKind.ToolCall ? part.toolCall._meta?.subagentRevision : undefined), [4, 3, 2]);
	});

	test('reopen uses newer task revisions without comparing independent workspace revisions', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-task-recovery-'));
		try {
			const agent = createAgent();
			const sessionUri = AgentSession.uri('backboard', 'task-recovery');
			const original: CliTsWorkerState = { handle: 'worker', sessionId: 'task-recovery', prompt: 'Recover worker', name: 'Alpha', revision: 2, status: 'running', executionStatus: 'running', integrationStatus: 'pending', readOnly: false, createdAt: '2026-09-05T12:00:00Z', workspace: { workerId: 'worker', revision: 900, status: 'Running', changedFileCount: 0, startedAt: '2026-09-05T12:00:00Z' } };
			const session = { sessionId: 'task-recovery', sessionUri, storedTurns: [{ prompt: 'Delegate work', response: '', parts: [{ kind: 'tool', id: 'worker', name: 'AgentSpawn', worker: original, workspace: original.workspace }] }], storedSubagentTurns: new Map([['worker', [{ prompt: original.prompt, response: '', failed: false }]]]) };
			const internals = agent as unknown as { _runtimeSessionsRoot(): string; _readRuntimeSubagentRecovery(): Promise<undefined>; _sessions: Map<string, unknown> };
			internals._runtimeSessionsRoot = () => tempRoot;
			internals._readRuntimeSubagentRecovery = async () => undefined;
			internals._sessions.set('task-recovery', session);
			fs.mkdirSync(path.join(tempRoot, 'task-recovery'), { recursive: true });
			const taskFile = path.join(tempRoot, 'task-recovery', 'agent-tasks.json');
			const recovered: CliTsWorkerState = { ...original, revision: 3, status: 'interrupted', executionStatus: 'interrupted', integrationStatus: 'skipped', error: 'The worker was interrupted during restart.', workspace: { ...original.workspace!, revision: 1, status: 'Failed' } };
			fs.writeFileSync(taskFile, JSON.stringify({ version: 1, tasks: [recovered, { ...recovered, sessionId: 'other-session', revision: 999, error: 'Wrong session' }] }));
			const parent = await agent.getSessionMessages(sessionUri);
			const parentTool = parent[0].responseParts[0];
			assert.ok(parentTool.kind === ResponsePartKind.ToolCall);
			assert.deepStrictEqual([parentTool.toolCall._meta?.subagentRevision, parentTool.toolCall._meta?.subagentStatus], [3, 'Failed']);
			// A stale snapshot read after the newer record must not regress the UI.
			fs.writeFileSync(taskFile, JSON.stringify({ version: 1, tasks: [original] }));
			const child = await agent.getSessionMessages(URI.parse(buildSubagentSessionUri(sessionUri.toString(), 'worker')));
			assert.deepStrictEqual([child[0]?.state, child[0]?.error, !!failureNote(child[0])], [TurnState.Complete, undefined, true]);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('integration review consumes verified coordinator bytes and preserves empty-file existence', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-integration-review-'));
		try {
			const database = store.add(await SessionDatabase.open(':memory:'));
			await database.createTurn('exact-integration-turn');
			const sessionUri = AgentSession.uri('backboard', 'exact-integration');
			const tracker = store.add(new FileEditTracker(sessionUri.toString(), database, {} as never, new NullLogService(), new TestDiffComputeService(), new NullEditSurvivalReporterFactory()));
			const agent = createAgent();
			const blobs = path.join(tempRoot, 'exact-integration', 'worker-integrations', 'blobs');
			fs.mkdirSync(blobs, { recursive: true });
			const snapshot = (bytes: Uint8Array) => {
				const sha256 = createHash('sha256').update(bytes).digest('hex');
				const contentPath = path.join(blobs, sha256);
				fs.writeFileSync(contentPath, bytes);
				return { contentPath, sha256, byteLength: bytes.length, mode: 0o100644 };
			};
			const coordinator = path.join(tempRoot, 'coordinator');
			const bytesBefore = Buffer.from('Other worker\noriginal\n');
			const bytesAfter = Buffer.from('Other worker\nupdated\n');
			const changes: CliTsWorkerIntegrationChange[] = [
				{ filePath: path.join(coordinator, 'shared.txt'), before: snapshot(bytesBefore), after: snapshot(bytesAfter) },
				{ filePath: path.join(coordinator, 'new-empty.txt'), after: snapshot(Buffer.alloc(0)) },
				{ filePath: path.join(coordinator, 'removed-empty.txt'), before: snapshot(Buffer.alloc(0)) },
				{ filePath: path.join(coordinator, 'binary.bin'), before: snapshot(Buffer.from([0, 255, 1])), after: snapshot(Buffer.from([0, 254, 2])) },
			];
			const turn = { turnId: 'exact-integration-turn', storedParts: [] as unknown[], toolSummaries: [], toolInputs: new Map(), toolInputSummaries: new Map(), startedToolCalls: new Set() };
			const session = { sessionId: 'exact-integration', sessionUri, workingDirectory: URI.file(coordinator), fileEdits: { tracker } };
			const internals = agent as unknown as { _runtimeSessionsRoot(): string; _publishWorkerIntegrationEdits(session: unknown, turn: unknown, id: string, recovery: unknown, changes: readonly CliTsWorkerIntegrationChange[]): Promise<void> };
			internals._runtimeSessionsRoot = () => tempRoot;
			await internals._publishWorkerIntegrationEdits(session, turn, 'worker', { fileEdits: [{ edits: [{ path: changes[0].filePath, before: 'private proposal before', after: 'private proposal after' }] }] }, changes);
			const toolId = 'worker-integration:worker';
			const stored = await database.readFileEditContent(toolId, changes[0].filePath);
			assert.deepStrictEqual([Buffer.from(stored!.beforeContent!), Buffer.from(stored!.afterContent!)], [bytesBefore, bytesAfter]);
			assert.deepStrictEqual((await database.getFileEdits([toolId])).map(record => record.kind), [FileEditKind.Edit, FileEditKind.Create, FileEditKind.Delete, FileEditKind.Edit]);
			const binary = await database.readFileEditContent(toolId, changes[3].filePath);
			assert.deepStrictEqual([...binary!.afterContent!], [0, 254, 2]);
			// An exact empty record proves no changes; a bad hash is never repaired
			// by relabeling the worker's private snapshot as coordinator output.
			await internals._publishWorkerIntegrationEdits(session, turn, 'no-changes', { fileEdits: [{ edits: [{ path: changes[0].filePath, before: 'a', after: 'b' }] }] }, []);
			await internals._publishWorkerIntegrationEdits(session, turn, 'bad-hash', undefined, [{ ...changes[0], after: { ...changes[0].after!, sha256: '0'.repeat(64) } }]);
			assert.deepStrictEqual(await database.getFileEdits(['worker-integration:no-changes', 'worker-integration:bad-hash']), []);
			assert.strictEqual(turn.storedParts.length, 1);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('worker integration publishes one parent review with net snapshots and persisted counts', async () => {
		const database = store.add(await SessionDatabase.open(':memory:'));
		await database.createTurn('parent-integration-turn');
		const sessionUri = AgentSession.uri('backboard', 'parent-integration-review');
		const counts = new TestDiffComputeService();
		const tracker = store.add(new FileEditTracker(sessionUri.toString(), database, {} as never, new NullLogService(), counts, new NullEditSurvivalReporterFactory()));
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const turn = {
			turnId: 'parent-integration-turn', storedParts: [] as unknown[], toolSummaries: [],
			toolInputs: new Map(), toolInputSummaries: new Map(), startedToolCalls: new Set(),
		};
		const session = { sessionUri, fileEdits: { tracker }, model: { id: 'fixture-model' } };
		const recovery = {
			fileEdits: [
				{ edits: [{ path: '/repo/worker.mjs', before: '', after: 'first' }] },
				{ edits: [{ path: '/repo/worker.mjs', before: 'first', after: 'one\ntwo\nthree' }] },
				{ edits: [{ path: '/repo/unchanged.mjs', before: 'same', after: 'same' }] },
			],
		};
		const internals = agent as unknown as {
			_publishWorkerIntegrationEdits(session: unknown, turn: unknown, id: string, recovery: unknown): Promise<void>;
		};
		await Promise.all([
			internals._publishWorkerIntegrationEdits(session, turn, 'worker-a', recovery),
			internals._publishWorkerIntegrationEdits(session, turn, 'worker-a', recovery),
		]);
		await internals._publishWorkerIntegrationEdits(session, turn, 'worker-a', recovery);
		const completed = progress.filter(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallComplete);
		assert.strictEqual(completed.length, 1);
		const completion = completed[0];
		assert.ok(completion?.kind === 'action' && completion.action.type === ActionType.ChatToolCallComplete);
		if (completion?.kind === 'action' && completion.action.type === ActionType.ChatToolCallComplete) {
			assert.strictEqual(completion.parentToolCallId, undefined, 'the parent observes the integration independently of the completed child writes');
			assert.strictEqual(completion.action.toolCallId, 'worker-integration:worker-a');
			assert.deepStrictEqual(completion.action.result.content?.map(item => item.type === ToolResultContentType.FileEdit ? item.diff : undefined), [{ added: 3, removed: 0 }]);
		}
		const records = await database.getFileEdits(['worker-integration:worker-a']);
		assert.deepStrictEqual(records.map(record => ({ path: record.filePath, kind: record.kind, added: record.addedLines, removed: record.removedLines })), [{ path: '/repo/worker.mjs', kind: FileEditKind.Create, added: 3, removed: 0 }]);
		assert.strictEqual(counts.callCount, 1);
		assert.strictEqual(turn.storedParts.length, 1, 'recovery keeps one deterministic integration result');
	});

	test('successful detached launch completes the frontend only at integration, while startup failure completes immediately', async () => {
		for (const startupFailed of [false, true]) {
			const agent = createAgent();
			const progress: AgentSignal[] = [];
			store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
			const sessionUri = AgentSession.uri('backboard', `deferred-launch-${startupFailed}`);
			const turn = {
				turnId: 'parent-turn', messageParts: new Map(), streamedText: new Map(),
				startedToolCalls: new Set(), confirmedToolCalls: new Set(), childToolLines: new Map(),
				toolSummaries: [], storedParts: [], storedTextParts: new Map(), toolInputs: new Map(),
				toolInputSummaries: new Map(), pendingCompletions: [] as Promise<void>[], subagentTurns: new Map(),
				workerWorkspaces: new Map(), responseText: '', reasoningText: '',
			};
			const session = { sessionUri, turn, storedSubagentTurns: new Map() };
			const internals = agent as unknown as {
				_handleAgentEvent(session: unknown, event: unknown): void;
				_readRuntimeSubagentRecovery(): Promise<undefined>;
			};
			internals._readRuntimeSubagentRecovery = async () => undefined;
			const emit = (event: object) => internals._handleAgentEvent(session, event);
			const completions = () => progress.filter(signal => signal.kind === 'action' && signal.parentToolCallId === undefined
				&& signal.action.type === ActionType.ChatToolCallComplete && signal.action.toolCallId === 'worker-launch');
			emit({ type: 'tool:requested', calls: [{ id: 'worker-launch', name: 'AgentSpawn', input: { prompt: 'Create a file.' } }] });
			emit({ type: 'tool:start', toolCallId: 'worker-launch', name: 'AgentSpawn' });
			if (!startupFailed) {
				emit({ type: 'agent:child_start', agentToolCallId: 'worker-launch', prompt: 'Create a file.', workspace: { workerId: 'worker-launch', status: 'Running', worktreePath: '/private/worker' } });
			}
			emit({ type: 'tool:result', toolCallId: 'worker-launch', name: 'AgentSpawn', title: startupFailed ? 'Worker unavailable' : 'Worker launched',
				...(startupFailed ? { execution: { outcome: 'error', failureCategory: 'unavailable' } } : {}) });
			await Promise.allSettled(turn.pendingCompletions);
			assert.strictEqual(completions().length, startupFailed ? 1 : 0, 'returning a handle must not finish the live worker card');
			if (!startupFailed) {
				// The private model ending is not a durable integration outcome.
				emit({ type: 'agent:child_end', agentToolCallId: 'worker-launch', status: 'completed' });
				await Promise.allSettled(turn.pendingCompletions);
				assert.strictEqual(completions().length, 0);
				emit({ type: 'agent:child_status', agentToolCallId: 'worker-launch', workspace: { workerId: 'worker-launch', status: 'Integrated', changedFileCount: 1 } });
				await Promise.allSettled(turn.pendingCompletions);
			}
			const completion = completions()[0];
			assert.ok(completion?.kind === 'action' && completion.action.type === ActionType.ChatToolCallComplete);
			if (completion?.kind === 'action' && completion.action.type === ActionType.ChatToolCallComplete) {
				assert.strictEqual(completion.action.result.success, !startupFailed);
			}
			assert.strictEqual(completions().length, 1);
		}
	});

	test('compact public child events recover the full Write result and diff from the child archive', async () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'worker-public-events');
		const rootTurn = {
			turnId: 'turn-public-events',
			messageParts: new Map(),
			streamedText: new Map(),
			startedToolCalls: new Set(),
			confirmedToolCalls: new Set(),
			childToolLines: new Map(),
			toolSummaries: [],
			storedParts: [],
			storedTextParts: new Map(),
			toolInputs: new Map(),
			toolInputSummaries: new Map(),
			pendingCompletions: [] as Promise<void>[],
			subagentTurns: new Map(),
			responseText: '',
			reasoningText: '',
		};
		const session = {
			sessionUri,
			turn: rootTurn,
			storedTurns: [],
			storedSubagentTurns: new Map(),
		};
		const fileEdit: ToolResultFileEditContent = {
			type: ToolResultContentType.FileEdit,
			before: { uri: URI.file('/workspace/renderer.ts').toString(), content: { uri: 'session-db://before' } },
			after: { uri: URI.file('/workspace/renderer.ts').toString(), content: { uri: 'session-db://after' } },
			diff: { added: 1, removed: 1 },
		};
		const internals = agent as unknown as {
			_sessions: Map<string, unknown>;
			_handleAgentEvent(session: unknown, event: unknown): void;
			_readRuntimeSubagentRecovery(toolCallId: string): Promise<unknown>;
			_buildFileEditContents(): Promise<ToolResultFileEditContent[]>;
		};
		internals._sessions.set(AgentSession.id(sessionUri), session);
		internals._buildFileEditContents = async () => [fileEdit];
		const recovery = {
			turn: {
				prompt: 'Audit the renderer output.',
				response: 'The renderer preserves and displays every child activity item.',
				parts: [{
					kind: 'tool',
					id: 'child-write',
					name: 'Write',
					inputSummary: 'renderer.ts',
					title: 'Wrote /workspace/renderer.ts',
				}, {
					kind: 'markdown',
					content: 'The renderer preserves and displays every child activity item.',
				}],
			},
			fileEdits: [{
				toolCallId: 'child-write',
				toolName: 'Write',
				toolInput: { file_path: '/workspace/renderer.ts', content: 'new' },
				title: 'Wrote /workspace/renderer.ts',
				edits: [{ path: '/workspace/renderer.ts', before: 'old', after: 'new' }],
			}],
		};
		internals._readRuntimeSubagentRecovery = async () => recovery;

		internals._handleAgentEvent(session, {
			type: 'tool:requested',
			calls: [{ id: 'agent-call-public', name: 'Subagent', input: { prompt: 'Audit the renderer output.' } }],
		});
		internals._handleAgentEvent(session, {
			type: 'tool:start',
			toolCallId: 'agent-call-public',
			name: 'Subagent',
			inputSummary: 'Audit the renderer output.',
		});
		internals._handleAgentEvent(session, {
			type: 'agent:child_tool_start',
			agentToolCallId: 'agent-call-public',
			call: { id: 'child-write', name: 'Write', inputSummary: 'renderer.ts' },
		});
		internals._handleAgentEvent(session, {
			type: 'agent:child_tool_result',
			agentToolCallId: 'agent-call-public',
			childToolCallId: 'child-write',
			status: 'done',
		});
		internals._handleAgentEvent(session, {
			type: 'tool:result',
			toolCallId: 'agent-call-public',
			name: 'Subagent',
			title: 'Completed in 2 rounds',
		});
		await Promise.allSettled(rootTurn.pendingCompletions);

		assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_started').length, 1);
		assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_completed').length, 1);
		const finalDeltaIndex = progress.findIndex(signal => signal.kind === 'action' && signal.parentToolCallId === 'agent-call-public'
			&& signal.action.type === ActionType.ChatDelta && signal.action.content === 'The renderer preserves and displays every child activity item.');
		const childCompleteIndex = progress.findIndex(signal => signal.kind === 'action' && signal.parentToolCallId === 'agent-call-public' && signal.action.type === ActionType.ChatTurnComplete);
		assert.ok(finalDeltaIndex >= 0 && childCompleteIndex > finalDeltaIndex, 'the live child receives its durable answer before completion');
		const childUri = URI.parse(buildSubagentSessionUri(sessionUri.toString(), 'agent-call-public'));
		const turns = await agent.getSessionMessages(childUri);
		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].message.text, 'Audit the renderer output.');
		const write = turns[0].responseParts.find((part): part is ToolCallResponsePart => part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === 'child-write');
		assert.strictEqual(write?.toolCall.status, ToolCallStatus.Completed);
		if (!write || write.toolCall.status !== ToolCallStatus.Completed) {
			assert.fail('Expected the recovered child Write to be completed');
		}
		assert.strictEqual(write.toolCall.pastTenseMessage, 'Wrote /workspace/renderer.ts');
		assert.deepStrictEqual(write.toolCall.content?.filter(content => content.type === ToolResultContentType.FileEdit), [fileEdit]);
		assert.ok(turns[0].responseParts.some(part => part.kind === ResponsePartKind.Markdown
			&& part.content === 'The renderer preserves and displays every child activity item.'));
	});

	test('historical Subagent tools reconstruct a non-empty child chat', async () => {
		const agent = createAgent();
		const sessionUri = AgentSession.uri('backboard', 'worker-history-fallback');
		const internals = agent as unknown as { _sessions: Map<string, unknown> };
		internals._sessions.set(AgentSession.id(sessionUri), {
			storedTurns: [{
				prompt: 'Delegate the audit',
				response: '',
				parts: [{
					kind: 'tool',
					id: 'agent-call-history',
					name: 'Subagent',
					inputSummary: 'Inspect every rendering path.',
					title: 'Completed in 3 rounds',
				}],
			}],
			storedSubagentTurns: new Map(),
		});

		const childUri = URI.parse(buildSubagentSessionUri(sessionUri.toString(), 'agent-call-history'));
		const turns = await agent.getSessionMessages(childUri);
		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].message.text, 'Inspect every rendering path.');
		assert.strictEqual(turns[0].responseParts[0]?.kind, ResponsePartKind.Markdown);
		if (turns[0].responseParts[0]?.kind === ResponsePartKind.Markdown) {
			assert.strictEqual(turns[0].responseParts[0].content, 'Completed in 3 rounds');
		}
	});

	test('historical runtime logs recover full subagent reasoning, tools, and response', async () => {
		const agent = createAgent();
		const fixtureDirectory = fs.mkdtempSync(`${os.tmpdir()}/cli-ts-subagent-history-`);
		try {
			fs.writeFileSync(`${fixtureDirectory}/meta.json`, JSON.stringify({
				prompt: 'Inspect the entire renderer path.',
			}), 'utf8');
			const events = [
				{ type: 'assistant:reasoning', text: 'Inspecting the renderer. ' },
				{ type: 'tool:requested', calls: [{ id: 'child-read', name: 'read', input: { file_path: 'renderer.ts' } }] },
				{ type: 'tool:start', toolCallId: 'child-read', name: 'Read', inputSummary: 'renderer.ts' },
				{ type: 'tool:result', toolCallId: 'child-read', name: 'Read', title: 'Read 120 lines', detail: 'The chat path is present.' },
				{ type: 'assistant:delta', messageId: 'child-message', text: 'The transcript now loads' },
				{ type: 'assistant:message', messageId: 'child-message', text: 'The transcript now loads.' },
				{ type: 'turn:end', status: 'completed' },
			].map((payload, sequence) => JSON.stringify({
				timestamp: '2026-08-24T00:00:00.000Z',
				session_id: 'fixture-session',
				sequence,
				source: 'client',
				type: payload.type,
				payload,
			})).join('\n');
			fs.writeFileSync(`${fixtureDirectory}/client.jsonl`, `${events}\n`, 'utf8');

			const internals = agent as unknown as {
				_readRuntimeSubagentRecoveryFromDirectory(directory: string): Promise<{
					turn: {
						prompt: string;
						response: string;
						parts?: readonly ({ kind: 'markdown' | 'reasoning'; content: string } | { kind: 'tool'; id: string; name: string; inputSummary?: string; title?: string; detail?: string })[];
					};
				} | undefined>;
			};
			const turn = (await internals._readRuntimeSubagentRecoveryFromDirectory(fixtureDirectory))?.turn;
			assert.strictEqual(turn?.prompt, 'Inspect the entire renderer path.');
			assert.strictEqual(turn?.response, 'The transcript now loads.');
			assert.deepStrictEqual(turn?.parts, [{
				kind: 'reasoning',
				content: 'Inspecting the renderer. ',
			}, {
				kind: 'tool',
				id: 'child-read',
				name: 'Read',
				inputSummary: 'renderer.ts',
				title: 'Read 120 lines',
				detail: 'The chat path is present.',
			}, {
				kind: 'markdown',
				content: 'The transcript now loads.',
			}]);
		} finally {
			fs.rmSync(fixtureDirectory, { recursive: true, force: true });
		}
	});

	test('runtime child recovery is scoped by parent session when tool-call ids repeat', async () => {
		const sessionsRoot = fs.mkdtempSync(`${os.tmpdir()}/cli-ts-subagent-session-scope-`);
		try {
			const writeChild = (sessionId: string, response: string): void => {
				const agentDirectory = path.join(sessionsRoot, sessionId, 'agents', 'call_1');
				fs.mkdirSync(agentDirectory, { recursive: true });
				fs.writeFileSync(path.join(agentDirectory, 'meta.json'), JSON.stringify({
					sessionId, toolCallId: 'call_1', prompt: `Task for ${sessionId}`,
				}), 'utf8');
				const payloads = [
					{ type: 'assistant:message', messageId: `message-${sessionId}`, text: response },
					{ type: 'turn:end', status: 'completed' },
				];
				fs.writeFileSync(path.join(agentDirectory, 'client.jsonl'), `${payloads.map((payload, sequence) => JSON.stringify({
					timestamp: '2026-09-01T00:00:00.000Z', session_id: sessionId, sequence,
					source: 'client', type: payload.type, payload,
				})).join('\n')}\n`, 'utf8');
			};
			writeChild('session-a', 'Result from session A.');
			writeChild('session-b', 'Result from session B.');

			const agent = createAgent();
			const internals = agent as unknown as {
				_runtimeSessionsRoot(): string;
				_readRuntimeSubagentRecovery(sessionId: string, toolCallId: string): Promise<{ turn: { response: string } } | undefined>;
				_runtimeSubagentTurnCache: Map<string, unknown>;
			};
			internals._runtimeSessionsRoot = () => sessionsRoot;
			const [first, second, firstAgain] = await Promise.all([
				internals._readRuntimeSubagentRecovery('session-a', 'call_1'),
				internals._readRuntimeSubagentRecovery('session-b', 'call_1'),
				internals._readRuntimeSubagentRecovery('session-a', 'call_1'),
			]);

			assert.strictEqual(first?.turn.response, 'Result from session A.');
			assert.strictEqual(second?.turn.response, 'Result from session B.');
			assert.strictEqual(firstAgain?.turn.response, 'Result from session A.');
			assert.strictEqual(internals._runtimeSubagentTurnCache.size, 2, 'cache identity includes parent session and provider call id');
		} finally {
			fs.rmSync(sessionsRoot, { recursive: true, force: true });
		}
	});

	test('reopened snapshot child archives map edits onto the actual coordinator, not the private Git repository', async () => {
		const fixtureRoot = fs.mkdtempSync(`${os.tmpdir()}/cli-ts-subagent-path-recovery-`);
		const database = store.add(new SessionDatabase(':memory:'));
		try {
			const coordinatorRoot = path.join(fixtureRoot, 'coordinator');
			const workerRoot = path.join(fixtureRoot, 'hidden-workers', 'worker-path-recovery');
			const privateRepositoryRoot = path.join(fixtureRoot, 'private-snapshots', 'repository');
			const coordinatorFile = path.join(coordinatorRoot, 'src', 'renderer.ts');
			const workerFile = path.join(workerRoot, 'src', 'renderer.ts');
			const sessionDirectory = path.join(fixtureRoot, 'session');
			const agentDirectory = path.join(sessionDirectory, 'agents', 'agent-path-recovery');
			fs.mkdirSync(agentDirectory, { recursive: true });
			fs.mkdirSync(coordinatorRoot, { recursive: true });
			fs.writeFileSync(path.join(agentDirectory, 'meta.json'), JSON.stringify({
				prompt: `Update ${workerFile}`,
			}), 'utf8');
			fs.writeFileSync(path.join(sessionDirectory, 'workers.json'), JSON.stringify({
				version: 1,
				workers: [{
					workerId: 'agent-path-recovery',
					parentToolCallId: 'agent-path-recovery',
					backend: 'snapshot',
					repositoryRoot: privateRepositoryRoot,
					worktreePath: workerRoot,
					coordinatorCwd: coordinatorRoot,
					integrationStatus: 'pending',
				}],
			}), 'utf8');
			const events = [
				{ type: 'tool:requested', calls: [{ id: 'child-write-path', name: 'Write', input: { file_path: workerFile, content: 'after' } }] },
				{ type: 'tool:start', toolCallId: 'child-write-path', name: 'Write', inputSummary: workerFile },
				{
					type: 'tool:result', toolCallId: 'child-write-path', name: 'Write',
					title: `Wrote ${workerFile}`, detail: `Updated ${workerFile}`,
					fileEdits: [{ path: workerFile, before: 'before', after: 'after' }],
				},
				{ type: 'assistant:message', messageId: 'child-path-message', text: `Updated ${workerFile}.` },
				{ type: 'turn:end', status: 'completed' },
			].map((payload, sequence) => JSON.stringify({
				timestamp: '2026-09-01T00:00:00.000Z', session_id: 'fixture-session', sequence,
				source: 'client', type: payload.type, payload,
			})).join('\n');
			fs.writeFileSync(path.join(agentDirectory, 'client.jsonl'), `${events}\n`, 'utf8');

			const agent = createAgent({}, createSessionDataService(database));
			const sessionUri = AgentSession.uri('backboard', 'worker-path-recovery');
			const internals = agent as unknown as {
				_sessions: Map<string, unknown>;
				_readRuntimeSubagentRecoveryFromDirectory(directory: string): Promise<unknown>;
				_readRuntimeSubagentRecovery(toolCallId: string): Promise<unknown>;
			};
			const rawRecovery = await internals._readRuntimeSubagentRecoveryFromDirectory(agentDirectory) as {
				fileEdits: Array<{ edits: Array<{ path: string }> }>;
				workerIntegrationStatus?: string;
				pathMapping?: { workerRoot: string; coordinatorRoot: string };
			};
			assert.strictEqual(rawRecovery.fileEdits[0].edits[0].path, workerFile, 'raw archive data remains unchanged');
			assert.deepStrictEqual(rawRecovery.pathMapping, { workerRoot, coordinatorRoot });
			// Simulate a previous buggy reopen that persisted the disposable worker
			// identity. The authoritative projected turn must not rehydrate this row.
			await database.storeFileEdit({
				turnId: 'legacy-worker-path', toolCallId: 'child-write-path', filePath: workerFile,
				kind: FileEditKind.Edit, addedLines: undefined, removedLines: undefined,
				beforeContent: new TextEncoder().encode('before'), afterContent: new TextEncoder().encode('after'),
			});
			internals._readRuntimeSubagentRecovery = async () => rawRecovery;
			const workspace = {
				workerId: 'agent-path-recovery', status: 'Integrated', changedFileCount: 1,
				startedAt: '2026-09-01T00:00:00.000Z', finishedAt: '2026-09-01T00:00:01.000Z',
			};
			internals._sessions.set(AgentSession.id(sessionUri), {
				workingDirectory: URI.file(coordinatorRoot),
				storedTurns: [{
					prompt: 'Delegate the renderer update.', response: '', parts: [{
						kind: 'tool', id: 'agent-path-recovery', name: 'AgentSpawn',
						inputSummary: 'Update the renderer.', title: 'Worker started',
						workspace,
					}],
				}],
				storedSubagentTurns: new Map(),
			});

			const childUri = URI.parse(buildSubagentSessionUri(sessionUri.toString(), 'agent-path-recovery'));
			for (const status of ['Running', 'Completed', 'Integrating', 'Conflict', 'Failed', 'Cancelled']) {
				workspace.status = status;
				const unintegrated = await agent.getSessionMessages(childUri);
				if (status === 'Conflict' || status === 'Failed' || status === 'Cancelled') {
					assert.ok(failureNote(unintegrated[0]), `${status} must not reopen as a successful worker`);
				}
				const write = unintegrated[0]?.responseParts.find((part): part is ToolCallResponsePart => part.kind === ResponsePartKind.ToolCall);
				assert.ok(write?.toolCall.status === ToolCallStatus.Completed);
				if (write?.toolCall.status === ToolCallStatus.Completed) {
					assert.strictEqual(write.toolCall.content?.some(content => content.type === ToolResultContentType.FileEdit) ?? false, false, `${status} must not advertise coordinator edits`);
				}
			}
			assert.deepStrictEqual((await database.getFileEdits(['child-write-path'])).map(record => record.filePath), [workerFile], 'unintegrated recovery must not create coordinator records');
			workspace.status = 'Integrated';
			const turns = await agent.getSessionMessages(childUri);
			const write = turns[0]?.responseParts.find((part): part is ToolCallResponsePart => part.kind === ResponsePartKind.ToolCall);
			assert.ok(write?.toolCall.status === ToolCallStatus.Completed);
			if (!write || write.toolCall.status !== ToolCallStatus.Completed) {
				assert.fail('Expected recovered child Write');
			}
			assert.strictEqual(write.toolCall.pastTenseMessage, `Wrote ${coordinatorFile}`);
			const edit = write.toolCall.content?.find((content): content is ToolResultFileEditContent => content.type === ToolResultContentType.FileEdit);
			assert.strictEqual(edit?.after?.uri, URI.file(coordinatorFile).toString());
			assert.strictEqual(JSON.stringify(turns).includes(privateRepositoryRoot), false, 'private snapshot repository must not become a displayed edit path');
			assert.strictEqual(turns[0].responseParts.some(part => part.kind === ResponsePartKind.Markdown && part.content.includes(workerRoot)), false);
			const persisted = await database.getFileEdits(['child-write-path']);
			assert.deepStrictEqual(new Set(persisted.map(record => record.filePath)), new Set([workerFile, coordinatorFile]));
			assert.strictEqual(write.toolCall.content?.filter(content => content.type === ToolResultContentType.FileEdit).length, 1, 'stale private DB rows must not re-enter the transcript');
			assert.strictEqual(rawRecovery.fileEdits[0].edits[0].path, workerFile, 'projection must not mutate cached raw recovery');
			workspace.status = 'Running';
			rawRecovery.workerIntegrationStatus = 'integrated';
			const authoritative = await agent.getSessionMessages(childUri);
			const authoritativeWrite = authoritative[0]?.responseParts.find((part): part is ToolCallResponsePart => part.kind === ResponsePartKind.ToolCall);
			assert.ok(authoritativeWrite?.toolCall.status === ToolCallStatus.Completed && authoritativeWrite.toolCall.content?.some(content => content.type === ToolResultContentType.FileEdit), 'durable workers.json integration also authorizes recovered edits');
		} finally {
			fs.rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	test('historical child tools recover their exact persisted file edits', async () => {
		const database = store.add(new SessionDatabase(':memory:'));
		await database.createTurn('child-turn-restored');
		await database.storeFileEdit({
			turnId: 'child-turn-restored',
			toolCallId: 'child-edit-restored',
			filePath: '/workspace/renderer.ts',
			kind: FileEditKind.Edit,
			addedLines: 4,
			removedLines: 2,
			beforeContent: new TextEncoder().encode('before'),
			afterContent: new TextEncoder().encode('after'),
		});
		const agent = createAgent({}, createSessionDataService(database));
		const sessionUri = AgentSession.uri('backboard', 'worker-restored-edit');
		const internals = agent as unknown as { _sessions: Map<string, unknown> };
		internals._sessions.set(AgentSession.id(sessionUri), {
			storedTurns: [],
			storedSubagentTurns: new Map([['agent-call-restored', [{
				prompt: 'Update the renderer.',
				response: 'Done.',
				parts: [{
					kind: 'tool',
					id: 'child-edit-restored',
					name: 'Edit',
					title: 'Updated renderer.ts',
				}],
			}]]]),
		});

		const childUri = URI.parse(buildSubagentSessionUri(sessionUri.toString(), 'agent-call-restored'));
		const turns = await agent.getSessionMessages(childUri);
		const tool = turns[0]?.responseParts.find((part): part is ToolCallResponsePart => part.kind === ResponsePartKind.ToolCall);
		assert.strictEqual(tool?.toolCall.status, ToolCallStatus.Completed);
		if (!tool || tool.toolCall.status !== ToolCallStatus.Completed) {
			assert.fail('Expected a completed restored child edit tool');
		}
		const edit = tool.toolCall.content?.find((content): content is ToolResultFileEditContent => content.type === ToolResultContentType.FileEdit);
		assert.ok(edit);
		assert.deepStrictEqual(edit.diff, { added: 4, removed: 2 });
		assert.deepStrictEqual(parseSessionDbUri(edit.before!.content.uri), {
			sessionUri: sessionUri.toString(),
			toolCallId: 'child-edit-restored',
			filePath: '/workspace/renderer.ts',
			part: 'before',
		});
		assert.deepStrictEqual(parseSessionDbUri(edit.after!.content.uri), {
			sessionUri: sessionUri.toString(),
			toolCallId: 'child-edit-restored',
			filePath: '/workspace/renderer.ts',
			part: 'after',
		});
	});

	test('stored Execute replay preserves terminal metadata and command output', async () => {
		const agent = createAgent();
		const sessionUri = AgentSession.uri('backboard', 'execute-replay');
		const sessionId = AgentSession.id(sessionUri);
		const internals = agent as unknown as { _sessions: Map<string, unknown> };
		internals._sessions.set(sessionId, {
			storedTurns: [{
				prompt: 'Run the verification command',
				response: '',
				parts: [{
					kind: 'tool',
					id: 'call-execute-restored',
					name: 'Execute',
					inputSummary: 'printf ready …',
					terminalCommand: 'printf ready && printf "\\nsecond\\nthird\\n"',
					title: 'Success',
					detail: '$ printf ready\nready\n… +2 more',
					terminalOutput: { text: 'ready\nsecond\nthird', exitCode: 0 },
				}],
			}],
		});

		const turns = await agent.getSessionMessages(sessionUri);
		const responsePart = turns[0].responseParts[0] as ToolCallResponsePart;
		assert.strictEqual(responsePart.kind, ResponsePartKind.ToolCall);
		assert.strictEqual(responsePart.toolCall.status, ToolCallStatus.Completed);
		if (responsePart.toolCall.status !== ToolCallStatus.Completed) { return; }
		assert.deepStrictEqual({
			status: responsePart.toolCall.status,
			toolName: responsePart.toolCall.toolName,
			toolInput: responsePart.toolCall.toolInput,
			content: responsePart.toolCall.content,
			meta: responsePart.toolCall._meta,
		}, {
			status: ToolCallStatus.Completed,
			toolName: 'Execute',
			toolInput: JSON.stringify({ command: 'printf ready && printf "\\nsecond\\nthird\\n"' }),
			content: [{ type: 'text', text: 'ready\nsecond\nthird' }],
			meta: { source: 'cli-ts', toolKind: 'terminal', language: 'shellscript', terminalExitCode: 0 },
		});
	});

	test('stored Execute replay preserves prompt-like stdout when the command is not exact', async () => {
		const agent = createAgent();
		const sessionUri = AgentSession.uri('backboard', 'execute-replay-prompt-output');
		const internals = agent as unknown as { _sessions: Map<string, unknown> };
		internals._sessions.set(AgentSession.id(sessionUri), {
			storedTurns: [{
				prompt: 'Run the whitespace check',
				response: '',
				parts: [{
					kind: 'tool',
					id: 'call-execute-prompt-output',
					name: 'Execute',
					inputSummary: "printf 'a  b'",
					title: 'Success',
					detail: "$ printf 'a b'\nreal output",
				}],
			}],
		});

		const turns = await agent.getSessionMessages(sessionUri);
		const responsePart = turns[0].responseParts[0] as ToolCallResponsePart;
		if (responsePart.toolCall.status !== ToolCallStatus.Completed) { return; }
		assert.deepStrictEqual(responsePart.toolCall.content, [{ type: 'text', text: "$ printf 'a b'\nreal output" }]);
	});

	test('stored AskUser results are omitted from replay', async () => {
		const agent = createAgent();
		const sessionUri = AgentSession.uri('backboard', 'ask-user-replay');
		const sessionId = AgentSession.id(sessionUri);
		const internals = agent as unknown as { _sessions: Map<string, unknown> };
		internals._sessions.set(sessionId, {
			storedTurns: [{
				prompt: 'Help me choose',
				response: 'I will adjust the gameplay.',
				parts: [{
					kind: 'tool',
					id: 'call-ask-user-restored',
					name: 'AskUser',
					title: 'Selected: Gameplay tweaks',
				}, {
					kind: 'markdown',
					content: 'I will adjust the gameplay.',
				}],
			}],
		});

		const turns = await agent.getSessionMessages(sessionUri);
		assert.strictEqual(turns[0].responseParts.length, 1);
		assert.strictEqual(turns[0].responseParts[0]?.kind, ResponsePartKind.Markdown);
	});

	test('client tool call carries its contributor and full input, and the completion round-trips', () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'client-tool-live');
		const notified: unknown[] = [];
		const session = {
			sessionUri,
			sessionId: AgentSession.id(sessionUri),
			clientTools: { clientId: 'client-1', tools: [{ name: 'open_browser_page' }] },
			turnAutoApproves: false,
			pendingClientToolCalls: new Set<string>(),
			proc: { isRunning: true, notify: (op: unknown) => notified.push(op), dispose: () => { } },
		};
		const internals = agent as unknown as {
			_sessions: Map<string, unknown>;
			_handleMappedAgentEvent(session: unknown, event: unknown, turn: unknown): void;
		};
		internals._sessions.set(session.sessionId, session);
		const turn = { turnId: 'turn-client', startedToolCalls: new Set<string>(), toolInputSummaries: new Map<string, string>(), toolInputs: new Map<string, { name: string; input: unknown }>() };

		internals._handleMappedAgentEvent(session, {
			type: 'client_tool:call',
			toolCallId: 'call-client-1',
			name: 'open_browser_page',
			input: { url: 'http://localhost:8765/index.html' },
		}, turn);

		const actions = progress
			.filter(signal => signal.kind === 'action')
			.map(signal => signal.kind === 'action' ? signal.action : undefined);
		const start = actions.find(action => action?.type === ActionType.ChatToolCallStart);
		assert.deepStrictEqual(start, {
			type: ActionType.ChatToolCallStart,
			turnId: 'turn-client',
			toolCallId: 'call-client-1',
			toolName: 'open_browser_page',
			displayName: 'Open Browser Page',
			contributor: { kind: ToolCallContributorKind.Client, clientId: 'client-1' },
			_meta: { source: 'cli-ts' },
		});
		const ready = actions.find(action => action?.type === ActionType.ChatToolCallReady);
		assert.ok(ready && ready.type === ActionType.ChatToolCallReady);
		assert.strictEqual(ready.toolInput, JSON.stringify({ url: 'http://localhost:8765/index.html' }));
		assert.strictEqual(ready._meta?.autoApproveBySetting, undefined, 'non-bypass turns must not auto-approve');
		assert.ok(session.pendingClientToolCalls.has('call-client-1'));

		// The workbench's ChatToolCallComplete routes back through the provider
		// and answers the parked serve call, images intact.
		agent.onClientToolCallComplete(sessionUri, 'call-client-1', {
			success: true,
			pastTenseMessage: 'Opened page',
			content: [
				{ type: ToolResultContentType.Text, text: 'Page ID: page_1' },
				{ type: ToolResultContentType.EmbeddedResource, data: 'aGk=', contentType: 'image/jpeg' },
			],
		});
		assert.deepStrictEqual(notified, [{
			op: 'clientToolResult',
			id: 'call-client-1',
			result: {
				success: true,
				content: [
					{ type: 'text', text: 'Page ID: page_1' },
					{ type: 'image', mimeType: 'image/jpeg', dataBase64: 'aGk=' },
				],
			},
		}]);
		assert.strictEqual(session.pendingClientToolCalls.size, 0);

		// A second completion for the same id (cli-ts's own tool:result echo)
		// is not forwarded again.
		agent.onClientToolCallComplete(sessionUri, 'call-client-1', { success: true, pastTenseMessage: 'Opened page' });
		assert.strictEqual(notified.length, 1);
	});

	test('a Full Access (bypass) turn stamps client tool calls auto-approved', () => {
		// The workbench runs client tools (IDE-side MCP servers) through its own
		// confirmation and result-review gates; this stamp is what lets it skip
		// both, so Full Access never shows an approval card.
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'client-tool-full-access');
		const session = {
			sessionUri,
			sessionId: AgentSession.id(sessionUri),
			clientTools: { clientId: 'client-1', tools: [{ name: 'hf_hub_query' }] },
			turnAutoApproves: true,
			pendingClientToolCalls: new Set<string>(),
			proc: { isRunning: true, notify: () => { }, dispose: () => { } },
		};
		const internals = agent as unknown as {
			_sessions: Map<string, unknown>;
			_handleMappedAgentEvent(session: unknown, event: unknown, turn: unknown): void;
		};
		internals._sessions.set(session.sessionId, session);
		const turn = { turnId: 'turn-full-access', startedToolCalls: new Set<string>(), toolInputSummaries: new Map<string, string>(), toolInputs: new Map<string, { name: string; input: unknown }>() };

		internals._handleMappedAgentEvent(session, {
			type: 'client_tool:call',
			toolCallId: 'call-full-access',
			name: 'hf_hub_query',
			input: { query: 'bert' },
		}, turn);

		const ready = progress
			.map(signal => signal.kind === 'action' ? signal.action : undefined)
			.find(action => action?.type === ActionType.ChatToolCallReady);
		assert.ok(ready && ready.type === ActionType.ChatToolCallReady);
		assert.strictEqual(ready._meta?.autoApproveBySetting, true);
		assert.strictEqual(ready.confirmed, ToolCallConfirmationReason.NotNeeded);
	});

	test('a declined client tool call is answered with an error result', () => {
		const agent = createAgent();
		const sessionUri = AgentSession.uri('backboard', 'client-tool-denied');
		const notified: unknown[] = [];
		const session = {
			sessionUri,
			sessionId: AgentSession.id(sessionUri),
			pendingClientToolCalls: new Set<string>(['call-denied']),
			proc: { isRunning: true, notify: (op: unknown) => notified.push(op), dispose: () => { } },
		};
		const internals = agent as unknown as { _sessions: Map<string, unknown> };
		internals._sessions.set(session.sessionId, session);

		agent.respondToPermissionRequest('call-denied', false);
		assert.deepStrictEqual(notified, [{
			op: 'clientToolResult',
			id: 'call-denied',
			error: 'The user declined this tool call.',
		}]);
		assert.strictEqual(session.pendingClientToolCalls.size, 0);

		// Approvals and unknown ids leave the pending set alone.
		agent.respondToPermissionRequest('call-unknown', false);
		assert.strictEqual(notified.length, 1);
	});
});
