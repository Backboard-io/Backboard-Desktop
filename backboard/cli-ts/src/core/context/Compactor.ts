import type { Config } from "../../config/Config.ts";
import {
	buildCompactionRequest,
	buildResumeContext,
	buildTrimmedResumeContext,
	COMPACTION_SYSTEM_PROMPT,
	extractHandoff,
} from "../../prompts/context/compaction.ts";
import type { AgentClient } from "../../providers/AgentClient.ts";
import { openRouterRouting } from "../agent/RunMessageRequestBuilder.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { Session } from "../session/Session.ts";
import { resolveContextWindow } from "./ContextWindow.ts";
import { charsForTokens, estimateTokens } from "./tokens.ts";
import {
	estimateTranscriptTokens,
	renderTodos,
	renderTranscript,
} from "./transcript.ts";

/** Exchanges replayed word-for-word after the handoff. */
const VERBATIM_TAIL_MESSAGES = 6;

/** Below this there is nothing worth compressing. */
const MIN_MESSAGES_TO_COMPACT = 2;

/**
 * Shares of the window. The summary request carries at most half of it (the
 * rest is system prompt, instructions and the summary itself), and the
 * word-for-word tail at most 15%, so the resumed conversation lands well
 * under the auto-compression threshold instead of re-triggering it.
 */
const SUMMARY_INPUT_SHARE = 0.5;
const VERBATIM_TAIL_SHARE = 0.15;

/** One retry absorbs a transient 429/5xx before falling back. */
const SUMMARY_ATTEMPTS = 2;

export interface CompactionResult {
	/** Text to prepend to the next turn so the agent resumes with its memory. */
	resumeContext: string;
	/** The handoff document alone, for display and for the session log. */
	handoff: string;
	beforeTokens: number;
	afterTokens: number;
	messagesCompacted: number;
	verbatimKept: number;
	/** Where the uncompressed run is on disk, for the post-compression notice. */
	transcriptPath?: string;
	/** True when no summary could be made and older history was dropped. */
	trimmed?: boolean;
}

export class CompactionError extends Error {}

export interface CompactorDeps {
	client: AgentClient;
	session: Session;
	config: Config;
	bus?: EventBus;
	/** Absolute path to this run's transcript, named in the resume context. */
	transcriptPath?: string;
}

/**
 * Compresses a conversation into a handoff document and restarts the thread
 * from it.
 *
 * Backend-agnostic on purpose. The summarization request goes through the same
 * `AgentClient` as everything else, with no thread id, so it lands on a
 * throwaway conversation rather than polluting the one being compressed - which
 * works identically whether that means a fresh Backboard thread or a fresh
 * local BYOK one. The result is delivered as context on the next turn, so
 * neither backend needs a server-side compaction endpoint.
 */
export class Compactor {
	constructor(private readonly deps: CompactorDeps) {}

	canCompact(): boolean {
		return this.deps.session.getMessages().length >= MIN_MESSAGES_TO_COMPACT;
	}

	async compact(
		options: {
			signal?: AbortSignal;
			/**
			 * Automatic compression must never leave a conversation stuck above
			 * the threshold: when no summary can be made, drop the older history
			 * (it stays in the transcript file) instead of failing the turn.
			 */
			fallbackToTrim?: boolean;
		} = {},
	): Promise<CompactionResult> {
		const { session, config } = this.deps;
		const messages = [...session.getMessages()];
		if (messages.length < MIN_MESSAGES_TO_COMPACT) {
			throw new CompactionError("Not enough conversation to compress yet.");
		}

		const limit = resolveContextWindow(
			config.model,
			session.reportedContextLimit,
		);
		// The tail must never swallow the whole history, or compression would
		// spend a model call and reset the thread while summarizing nothing.
		// Half is the floor: there is always as much summarized as carried.
		const rendered = renderTranscript(messages, {
			verbatimTailMessages: Math.min(
				VERBATIM_TAIL_MESSAGES,
				Math.floor(messages.length / 2),
			),
			headBudgetChars: charsForTokens(limit * SUMMARY_INPUT_SHARE),
			tailBudgetChars: charsForTokens(limit * VERBATIM_TAIL_SHARE),
		});
		// Prefer what the provider measured; fall back to an estimate when no
		// turn has reported usage yet (e.g. compressing straight after a resume).
		const beforeTokens =
			session.contextTokens || estimateTranscriptTokens(messages);

		let handoff: string;
		try {
			handoff = await this.summarizeWithRetry(rendered, options.signal);
		} catch (error) {
			if (!options.fallbackToTrim || options.signal?.aborted) throw error;
			return this.finish(
				messages,
				rendered,
				beforeTokens,
				"",
				buildTrimmedResumeContext(
					rendered.verbatimTail,
					this.deps.transcriptPath,
				),
			);
		}

		return this.finish(
			messages,
			rendered,
			beforeTokens,
			handoff,
			buildResumeContext(
				handoff,
				rendered.verbatimTail,
				this.deps.transcriptPath,
			),
		);
	}

	private async summarizeWithRetry(
		rendered: ReturnType<typeof renderTranscript>,
		signal: AbortSignal | undefined,
	): Promise<string> {
		let lastError: unknown;
		for (let attempt = 0; attempt < SUMMARY_ATTEMPTS; attempt++) {
			try {
				return await this.summarize(rendered, signal);
			} catch (error) {
				if (signal?.aborted) throw error;
				lastError = error;
			}
		}
		throw lastError;
	}

	private async summarize(
		rendered: ReturnType<typeof renderTranscript>,
		signal: AbortSignal | undefined,
	): Promise<string> {
		const { session, config, client } = this.deps;
		const route = { ...config.model, source: config.modelSource };
		const response = await client.sendMessage(
			{
				content: buildCompactionRequest({
					transcript: rendered.transcript,
					verbatimTurns: rendered.verbatimCount,
					todos: renderTodos(session.todos),
				}),
				llm_provider: route.provider,
				model_name: route.model,
				...(route.source === undefined ? {} : { source: route.source }),
				system_prompt: COMPACTION_SYSTEM_PROMPT,
				// No tools and no memory: this is a pure text transformation, and
				// letting it call tools or write memories would be both slow and a
				// way for compression to change the world it is describing.
				tools: [],
				memory: "off",
				...(route.provider === "openrouter"
					? { openrouter: openRouterRouting(config.selectedOpenRouterProvider) }
					: {}),
			},
			signal === undefined ? {} : { signal },
		);

		const handoff = extractHandoff(response.content ?? "");
		if (!handoff.trim()) {
			throw new CompactionError(
				"The model returned an empty summary; nothing was compressed.",
			);
		}
		// Compression replaces the conversation, so a bad summary is destructive
		// in a way a bad ordinary reply is not. A backend can answer HTTP 200
		// with an error string in the content field (an unsupported model, a
		// quota message); accepting that would swap the real history for an
		// error message. Requiring the document's own structure is the cheapest
		// reliable proof that the model actually did the job.
		if (!looksLikeHandoff(handoff)) {
			throw new CompactionError(
				`The model did not return a usable summary, so nothing was compressed. It replied: ${handoff.slice(0, 200)}`,
			);
		}
		return handoff;
	}

	private finish(
		messages: readonly unknown[],
		rendered: ReturnType<typeof renderTranscript>,
		beforeTokens: number,
		handoff: string,
		resumeContext: string,
	): CompactionResult {
		const { session } = this.deps;
		// Todos are working state, not history - they must survive the reset or
		// compression would silently drop the agent's own plan.
		const todos = [...session.todos];
		session.reset();
		if (todos.length > 0) session.setTodos(todos);

		return {
			resumeContext,
			handoff,
			beforeTokens,
			afterTokens: estimateTokens(resumeContext),
			messagesCompacted: messages.length - rendered.verbatimCount,
			verbatimKept: rendered.verbatimCount,
			...(this.deps.transcriptPath
				? { transcriptPath: this.deps.transcriptPath }
				: {}),
			...(handoff ? {} : { trimmed: true }),
		};
	}
}

/** At least two of the required sections must be present to trust the reply. */
function looksLikeHandoff(text: string): boolean {
	const sections = [
		/^##\s*Objective/im,
		/^##\s*Current State/im,
		/^##\s*Active Work/im,
		/^##\s*Next Steps/im,
		/^##\s*Files Touched/im,
		/^##\s*Technical Decisions/im,
		/^##\s*Problems and Resolutions/im,
		/^##\s*History/im,
	];
	return sections.filter((section) => section.test(text)).length >= 2;
}
