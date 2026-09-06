import { browser } from "../../../system/browser.tsx";
import { computer } from "../../../system/computer.tsx";
import type { SystemPromptOptions } from "../../../system/types.ts";
import { buildWorkflowPrompt } from "../../../system/workflow.ts";
import { buildSystemPromptWith } from "../../_shared/system/build.tsx";

/** OpenAI persona with the same gated capability slots as every other profile. */
export function buildSystemPrompt(options: SystemPromptOptions = {}): string {
	return buildSystemPromptWith(
		{
			getSystemPromptFragment: (_id, context = {}) =>
				`You are Backboard, Backboard.io's coding agent. Make focused changes and use tools to establish correctness.\n\n${buildWorkflowPrompt(context)}`,
			computer,
			browser,
		},
		options,
	);
}
