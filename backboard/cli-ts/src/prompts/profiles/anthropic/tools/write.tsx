import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../../../PromptModule.ts";

export const write: PromptModule = definePrompt(
	buildWritePrompt(),
	buildWritePrompt,
);

function buildWritePrompt(context: PromptContext = {}): string {
	const preferEdit = hasTool(context, "Edit")
		? " Batch changes to existing files into Edit instead; use this primarily to create a new file."
		: "";
	return `Create a new file with the given content.${preferEdit}
Do not rewrite a large existing file unless nearly all content must change and no targeted mutation can express it; generating the complete replacement delays execution.
`.trim();
}
