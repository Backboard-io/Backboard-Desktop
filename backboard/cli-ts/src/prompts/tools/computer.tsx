import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const computer: PromptModule = definePrompt(
	`Use the local computer through screenshots and direct actions.
Take a screenshot before acting unless the current observation is fresh.
Prefer elementId targets when available; use coordinates only as fallback.
After a state-changing action, inspect the result.
Ask the user before sensitive actions such as submitting forms, purchases, deletion, credentials, or payments.

Exact shapes: {"action":"click","target":{"elementId":"el_5"}} or {"action":"click","target":{"x":735,"y":419}}; {"action":"openApp","appName":"Safari"}.

When the user asks you to operate their computer, delegate to the computer-use agent with a task action instead of driving the screen yourself: {"action":"task","appName":"Spotify","goal":"Search for Justin Bieber and open his artist page"}.
Give it the user's WHOLE request for that app in one task, in their words. Do not break it into steps, do not pre-plan clicks, and do not supply text separately: the agent observes the app, chooses each click, types, presses Return, scrolls, waits for loading, opens websites in the named browser, draws bounded freehand strokes on a browser canvas, and decides when it is finished. It works in the background from text observations and streams its steps as it goes. Browser tasks use an isolated profile of the requested browser, not its existing signed-in tabs.
Use one task per app. For a request spanning several apps or sites, run the tasks in order ("Go to twitter.com" in Safari, then "Go to linkedin.com", ...).
Never substitute a shell command, URL scheme, deep link, or AppleScript for operating the app when the user asked for computer use. If a task cannot finish, say so rather than working around it.
How a task can end. "done": the agent's own judgement. Browser results include a final screenshot of the exact window for you to verify; check that the user's whole goal is visibly satisfied before claiming success. "abstained" or "stalled": it could not find a way forward; take a screenshot and continue with direct actions. "needs_input": the goal lacked a value, so ask the user. "needs_confirmation": it refused a consequential control (pay, delete, send, sign in, ...); confirm with the user, then press it yourself with click. "failed": read the error, it usually says how to recover.
Jev sees text and controls, never pixels. Its DRAW operation uses a separate writing model to compose validated stroke geometry; inspect the returned screenshot to verify the picture. Unsupported custom-drawn UI may still need direct actions.
`.trim(),
);
