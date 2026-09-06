import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const create: PromptModule = definePrompt(
	`Creates a new file on the file system with the specified content. Prefer editing existing files, unless you need to create a new file.
`.trim(),
);
