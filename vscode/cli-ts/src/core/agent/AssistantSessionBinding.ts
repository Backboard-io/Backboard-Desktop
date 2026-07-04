import { ensureAssistant } from "../../providers/backboard/assistants.ts";
import type { BackboardClient } from "../../providers/backboard/BackboardClient.ts";
import type { Session } from "../session/Session.ts";
import type { OpenAITool } from "../tools/schema.ts";

export class AssistantSessionBinding {
	private inFlight: Promise<string> | null = null;

	constructor(
		private readonly client: BackboardClient,
		private readonly session: Session,
		private readonly fresh = false,
	) {}

	async resolve(input: {
		systemPrompt: string;
		tools: OpenAITool[];
		signal?: AbortSignal;
	}): Promise<string> {
		if (this.session.assistantId) return this.session.assistantId;
		// Dedupe concurrent resolves (e.g. an eager warm-up racing the first
		// turn) so we never create two assistants for the same session.
		if (this.inFlight) return this.inFlight;

		this.inFlight = ensureAssistant(
			this.client,
			input.systemPrompt,
			input.tools,
			{ signal: input.signal, fresh: this.fresh },
		)
			.then((assistantId) => {
				this.session.assistantId = assistantId;
				return assistantId;
			})
			.finally(() => {
				this.inFlight = null;
			});
		return this.inFlight;
	}
}
