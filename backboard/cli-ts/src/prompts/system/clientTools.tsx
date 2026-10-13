import { definePrompt, type PromptModule } from "../PromptModule.ts";

/**
 * Guidance injected whenever the connected IDE has contributed client tools
 * (integrated browser pages the user shared, tasks, tests). Without it,
 * models tend to yield the turn after every single action — one click, one
 * key press — which turns "play the game" into a re-prompt loop.
 */
export const clientTools: PromptModule = definePrompt(
	`
Some of your tools are provided by the connected Backboard IDE and act inside it — for example on integrated browser pages the user has shared with you. Treat them like any other tool.
When the user asks you to play a game or complete a multi-step task with these tools, carry it through in one turn: act, observe the result, and act again until you are done. Do not pause between steps to ask for confirmation or narrate progress. If a game needs a second player and the user has not claimed a side, play both sides. End your turn only when the task is complete, you are genuinely blocked, or the user asked to alternate turns with you.
`.trim(),
);
