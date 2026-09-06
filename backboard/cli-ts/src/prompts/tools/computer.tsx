import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const computer: PromptModule = definePrompt(
	`Use the local computer through screenshots and direct actions.
Take a screenshot before acting unless the current observation is fresh.
Prefer elementId targets when available; use coordinates only as fallback.
After a state-changing action, inspect the result.
Ask the user before sensitive actions such as submitting forms, purchases, deletion, credentials, or payments.

`.trim(),
);
