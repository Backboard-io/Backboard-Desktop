import { definePrompt, type PromptModule } from "../../../PromptModule.ts";

export const askUser: PromptModule = definePrompt(
	`Ask the user a multiple-choice question mid-task to pin down a requirement or decision.

Important:
- Ask only when the answer changes what you build; resolve everything else from the request, the code, or sensible defaults.
- Each interruption costs the user focus — when several questions are pending, lead with the most load-bearing one; its answer often settles the rest.
- Keep the question short and tightly scoped, with 2-4 mutually exclusive options. The user can always supply their own answer, so never add an "other" option.
- If you have not already laid out the context and trade-offs before calling this, put that context in the question text so the choice stands on its own. Keep option labels short but make the question self-explanatory.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`question\` | \`string\` | yes | The question to ask the user |
| \`options\` | \`array\` | yes | Multiple-choice options to present |`.trim(),
);
