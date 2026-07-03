import { z } from "zod";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";

const schema = z.object({
	question: z.string().describe("The question to ask the user"),
	options: z
		.array(z.string())
		.min(1)
		.describe("Multiple-choice options to present"),
});

type Input = z.infer<typeof schema>;

interface Output {
	question: string;
	answer: string;
}

export class AskUserTool extends Tool<Input, Output> {
	readonly name = "AskUser";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isReadOnly(): boolean {
		return false;
	}

	override isConcurrencySafe(): boolean {
		return false;
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const answer = await ctx.askUser(input.question, input.options);
		const title = input.options.includes(answer)
			? `Selected: ${answer}`
			: `Answered: ${answer}`;
		return ok(
			{ question: input.question, answer },
			`User answered: ${answer}`,
			title,
		);
	}
}
