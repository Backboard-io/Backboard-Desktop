import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const browser: PromptModule = definePrompt(
	`Use Browser for Chromium tab automation through screenshots and direct page actions.
When the user has shared a page from the integrated browser, Browser drives that exact tab — screenshot it first instead of navigating away.
Use navigate for URLs instead of typing them into the address bar.
Take a screenshot before clicking elementId targets unless the current observation is fresh.
Prefer elementId targets when available; use coordinates only as fallback. Canvas-rendered pages (games) have no elements — use screenshots plus x/y coordinates and keys.
For keyboard input, use key actions like { action: "key", key: "w" } (single characters keep their case; named keys: ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Enter, Space, Escape, Tab, Backspace).
For games: hold a movement key with holdMs ({ action: "key", key: "ArrowRight", holdMs: 500 }), or pair phase "down"/"up" across actions to hold one key while pressing another. Queue several actions with defaultDelayMs to play fluidly. Use { action: "type", mode: "keys" } when a page listens for real key events.
When asked to play a game, play it through in one turn — act, observe, act again. Do not stop between moves to ask or report; if the game needs a second player and the user has not claimed a side, play both sides. Stop only when the game ends or you are truly stuck.
Ask the user before sensitive actions such as submitting forms, purchases, deletion, credentials, or payments.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`actions\` | \`array\` | yes | Serial queue of 1-20 Browser action objects. |
| \`defaultDelayMs\` | \`number\` | no | Delay between queued actions. |
| \`stopOnError\` | \`boolean\` | no | Stop queued execution after the first failed action. |

### Actions

| Action | Required fields | Optional fields |
| --- | --- | --- |
| \`screenshot\` | \`action\` | _none_ |
| \`navigate\` | \`action\`, \`url\` | _none_ |
| \`click\` | \`action\`, \`elementId\` or \`x\` and \`y\` | \`target\`, \`button\` |
| \`type\` | \`action\`, \`text\` | \`mode\` (\`insert\` or \`keys\`) |
| \`key\` | \`action\`, \`key\` | \`modifiers\`, \`holdMs\`, \`phase\` (\`down\`/\`up\`/\`press\`) |
| \`scroll\` | \`action\`, \`deltaX\` or \`deltaY\` | \`elementId\` or \`x\`/\`y\` |
| \`drag\` | \`action\`, \`from\`, \`to\` | \`durationMs\` |
| \`wait\` | \`action\`, \`durationMs\` or \`ms\` | _none_ |`.trim(),
);
