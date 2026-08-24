/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentSession, type AgentSignal } from '../../common/agentService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { buildSubagentSessionUri, ResponsePartKind, ToolCallStatus, type ToolCallResponsePart } from '../../common/state/sessionState.js';
import { CliTsAgent } from '../../node/cliTs/cliTsAgent.js';

suite('CliTsAgent tool metadata', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createAgent(): CliTsAgent {
		return store.add(new CliTsAgent(
			new NullLogService(),
			{} as never,
			{} as never,
			{} as never,
		));
	}

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

	test('Execute tool start advertises terminal metadata', () => {
		const agent = createAgent();
		const progress: AgentSignal[] = [];
		store.add(agent.onDidSessionProgress(signal => progress.push(signal)));
		const sessionUri = AgentSession.uri('backboard', 'execute-live');
		const internals = agent as unknown as {
			_ensureToolCallStart(
				session: { sessionUri: typeof sessionUri },
				turn: { turnId: string; startedToolCalls: Set<string>; toolInputSummaries: Map<string, string> },
				toolCallId: string,
				toolName: string,
				inputSummary?: string,
			): void;
		};
		const turn = { turnId: 'turn-execute', startedToolCalls: new Set<string>(), toolInputSummaries: new Map<string, string>(), toolInputs: new Map<string, { name: string; input: unknown }>() };

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
					inputSummary: 'printf ready',
					title: 'Success',
					detail: '$ printf ready\nready',
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
			toolInput: 'printf ready',
			content: [{ type: 'text', text: 'ready' }],
			meta: { source: 'cli-ts', toolKind: 'terminal', language: 'shellscript' },
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
});
