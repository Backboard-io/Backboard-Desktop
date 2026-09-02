import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const write: PromptModule = definePrompt(
	buildWritePrompt(),
	buildWritePrompt,
);

function buildWritePrompt(context: PromptContext = {}): string {
	return `Write the full contents of a file.

Use this primarily for new files. For an existing file, do not use Write unless nearly all of its content must be replaced and a targeted edit or patch cannot express the change.${hasTool(context, "Edit") ? " Batch targeted changes to an existing file into one Edit call instead." : ""}${hasTool(context, "ApplyPatch") ? " Prefer ApplyPatch for reviewable or multi-file changes." : ""}
Re-emitting a large existing file delays execution because the complete content must be generated before the write can begin.
The parent directory is created when needed. Existing files are overwritten.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`file_path\` | \`string\` | yes | The path to the file to write |
| \`content\` | \`string\` | yes | The complete file contents |`.trim();
}
