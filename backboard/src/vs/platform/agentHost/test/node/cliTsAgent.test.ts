/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentSession, type AgentSignal } from '../../common/agentService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { buildSubagentSessionUri, FileEditKind, ResponsePartKind, ToolCallContributorKind, ToolCallStatus, ToolResultContentType, TurnState, type ToolCallResponsePart, type ToolResultFileEditContent } from '../../common/state/sessionState.js';
import { AgentHostCheckpointService } from '../../node/agentHostCheckpointService.js';
import { assertUsableClaudeSubscriptionLogin, CliTsAgent, getBackboardWorktreeBranchName, getBackboardWorktreesRoot, hasUsableChatGptSubscriptionLogin, isChatGptSubscriptionModel, isClaudeSubscriptionModel, requiresProviderThreadHandoff, withChatGptSubscriptionConnectionState, withClaudeSubscriptionConnectionState } from '../../node/cliTs/cliTsAgent.js';
import { SessionDatabase } from '../../node/sessionDatabase.js';
import { parseSessionDbUri } from '../../node/shared/fileEditTracker.js';
import { createSessionDataService } from '../common/sessionTestHelpers.js';

suite('CliTsAgent tool metadata', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createAgent(checkpointService: unknown = {}, sessionDataService: unknown = {}, gitService: unknown = {}, configurationService: unknown = { getSessionConfigValues: () => ({}) }): CliTsAgent {
		return store.add(new CliTsAgent(
			new NullLogService(),
			configurationService as never,
			sessionDataService as never,
			{} as never,
			checkpointService as never,
			gitService as never,
		));
	}

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
				proc?: { isRunning: boolean; dispose(): void; notify(value: unknown): void };
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
		};

		await agent.changeModel(created.session, { id: 'openai/gpt-5.6' });

		assert.strictEqual(session.model?.id, 'openai/gpt-5.6');
		assert.strictEqual(session.threadId, undefined);
		assert.strictEqual(session.proc, undefined);
		assert.strictEqual(disposed, 1);
		assert.strictEqual(notified, 0);
		assert.strictEqual(storeWrites, 1);
		assert.strictEqual(session.forkContext, undefined);
		assert.match(session.providerHandoffContext ?? '', /ORCHID/);
		assert.match(session.providerHandoffContext ?? '', /changed model providers/);
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

	test('refuses to start interactive Claude OAuth through the stdin-less agent command', async () => {
		await assert.rejects(
			createAgent().executeCommand('claudeSubscription.login'),
			/requires an interactive terminal/,
		);
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
			assert.strictEqual(restored[0].state, TurnState.Error);
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
			assert.strictEqual(legacy[0].state, TurnState.Error);
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
			storedParts: [] as Array<{ kind: string; terminalCommand?: string; terminalOutput?: unknown }>,
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
			meta: completion.action._meta,
			content: completion.action.result.content,
		}, {
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
			calls: [{ id: 'agent-isolated', name: 'Agent', input: { prompt: 'Implement the renderer change.' } }],
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
			subagentAgentName: 'worker',
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

		assert.ok(progress.some(signal => signal.kind === 'action'
			&& signal.parentToolCallId === 'spawn-rejected'
			&& signal.action.type === ActionType.ChatError));
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
		assert.ok(spawnComplete?.kind === 'action' && spawnComplete.action.type === ActionType.ChatToolCallComplete);
		assert.strictEqual(spawnComplete.action._meta?.subagentDetached, true);

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
			detail: 'The renderer preserves and displays every child activity item.',
		});
		await Promise.allSettled(rootTurn.pendingCompletions);

		assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_started').length, 1);
		assert.strictEqual(progress.filter(signal => signal.kind === 'subagent_completed').length, 1);
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

	test('reopened child archives remap private worker edits onto coordinator paths', async () => {
		const fixtureRoot = fs.mkdtempSync(`${os.tmpdir()}/cli-ts-subagent-path-recovery-`);
		const database = store.add(new SessionDatabase(':memory:'));
		try {
			const coordinatorRoot = path.join(fixtureRoot, 'coordinator');
			const workerRoot = path.join(fixtureRoot, 'hidden-workers', 'worker-path-recovery');
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
					worktreePath: workerRoot,
					coordinatorCwd: coordinatorRoot,
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
			};
			assert.strictEqual(rawRecovery.fileEdits[0].edits[0].path, workerFile, 'raw archive data remains unchanged');
			// Simulate a previous buggy reopen that persisted the disposable worker
			// identity. The authoritative projected turn must not rehydrate this row.
			await database.storeFileEdit({
				turnId: 'legacy-worker-path', toolCallId: 'child-write-path', filePath: workerFile,
				kind: FileEditKind.Edit, addedLines: undefined, removedLines: undefined,
				beforeContent: new TextEncoder().encode('before'), afterContent: new TextEncoder().encode('after'),
			});
			internals._readRuntimeSubagentRecovery = async () => rawRecovery;
			internals._sessions.set(AgentSession.id(sessionUri), {
				workingDirectory: URI.file(coordinatorRoot),
				storedTurns: [{
					prompt: 'Delegate the renderer update.', response: '', parts: [{
						kind: 'tool', id: 'agent-path-recovery', name: 'AgentSpawn',
						inputSummary: 'Update the renderer.', title: 'Worker started',
						workspace: {
							workerId: 'agent-path-recovery', status: 'Integrated', changedFileCount: 1,
							startedAt: '2026-09-01T00:00:00.000Z', finishedAt: '2026-09-01T00:00:01.000Z',
						},
					}],
				}],
				storedSubagentTurns: new Map(),
			});

			const childUri = URI.parse(buildSubagentSessionUri(sessionUri.toString(), 'agent-path-recovery'));
			const turns = await agent.getSessionMessages(childUri);
			const write = turns[0]?.responseParts.find((part): part is ToolCallResponsePart => part.kind === ResponsePartKind.ToolCall);
			assert.ok(write?.toolCall.status === ToolCallStatus.Completed);
			if (!write || write.toolCall.status !== ToolCallStatus.Completed) {
				assert.fail('Expected recovered child Write');
			}
			assert.strictEqual(write.toolCall.pastTenseMessage, `Wrote ${coordinatorFile}`);
			const edit = write.toolCall.content?.find((content): content is ToolResultFileEditContent => content.type === ToolResultContentType.FileEdit);
			assert.strictEqual(edit?.after?.uri, URI.file(coordinatorFile).toString());
			assert.strictEqual(turns[0].responseParts.some(part => part.kind === ResponsePartKind.Markdown && part.content.includes(workerRoot)), false);
			const persisted = await database.getFileEdits(['child-write-path']);
			assert.deepStrictEqual(new Set(persisted.map(record => record.filePath)), new Set([workerFile, coordinatorFile]));
			assert.strictEqual(write.toolCall.content?.filter(content => content.type === ToolResultContentType.FileEdit).length, 1, 'stale private DB rows must not re-enter the transcript');
			assert.strictEqual(rawRecovery.fileEdits[0].edits[0].path, workerFile, 'projection must not mutate cached raw recovery');
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
