import { definePrompt, type PromptModule } from "../../../PromptModule.ts";

export const computer: PromptModule = definePrompt(
	`Observe and drive the local computer through screenshots and direct actions.
Take a screenshot before acting unless your last observation is still current.
Target elementId when you have it; fall back to x/y coordinates only when you must.
After any state-changing action, read the result before you continue.
Get the user's approval before anything sensitive or irreversible: form submissions, purchases, deletions, credentials, or payments.

`.trim(),
);
