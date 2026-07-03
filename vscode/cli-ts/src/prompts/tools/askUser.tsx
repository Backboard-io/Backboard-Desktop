import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const askUser: PromptModule = definePrompt(
	`Use this tool when you need to ask the user a quick multiple-choice question during execution to clarify requirements or decisions.

Important:
- Keep the question short and focused.
- The tool can be used more than once if there are important questions that needs to be asked
- User has an option to provide own custom answers, if they don't like suggested ones.
- If you haven't already explained the context and trade-offs of the options before invoking this tool, you MUST include that context in the question text itself so the user understands what they're choosing and why it matters. Keep option labels short, but make the question descriptive enough to stand on its own.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`question\` | \`string\` | yes | The question to ask the user |
| \`options\` | \`array\` | yes | Multiple-choice options to present |`.trim(),
);
