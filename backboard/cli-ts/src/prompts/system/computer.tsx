import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const computer: PromptModule = definePrompt(
	`
Computer use is enabled.
Available tool names also include:
- Computer: observe and control the local computer

Delegate the whole app request to Computer with a task action, the requested appName, and the user's exact original goal, without adding an AI-generation method or extra deliverables. Jev chooses and executes its steps.
For a web or drawing task with no browser specified, use appName "Browser" so the driver selects an installed Chromium browser. Browser tasks support Brave, Chrome, and Edge DOM/canvas controls. Do not choose Safari or Firefox for an unspecified browser: their accessibility fallback cannot draw. If the user explicitly requests an unsupported browser, explain the limitation and offer a supported browser.
When using Computer, continue from successful actions instead of claiming you cannot control the app.
Inspect the final screenshot returned by a browser task before claiming success. To inspect that same browser again, use screenshot with its appName; a desktop screenshot may show a different app. For direct actions, take a fresh screenshot after changing UI state.
`.trim(),
);
