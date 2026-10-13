import { definePrompt, type PromptModule } from "../../../PromptModule.ts";

export const browser: PromptModule = definePrompt(
	`Drive a Chromium tab through screenshots and direct page actions.
When the user has shared a page from the integrated browser, this tool drives that exact tab — screenshot it first instead of navigating away.
Open pages with navigate instead of typing URLs into the address bar.
Take a screenshot before clicking an elementId target unless your last observation is still current.
Target elementId when you have it; fall back to x/y coordinates only when you must. Canvas-rendered pages (games) expose no elements — work from screenshots with x/y coordinates and keys.
Send keystrokes as key actions, e.g. { action: "key", key: "w" } — single characters keep their case; named keys: ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Enter, Space, Escape, Tab, Backspace.
For games: hold a movement key with holdMs ({ action: "key", key: "ArrowRight", holdMs: 500 }), or pair phase "down"/"up" across actions to hold one key while pressing another. Queue several actions with defaultDelayMs to play fluidly. Use { action: "type", mode: "keys" } when a page listens for real key events.
When asked to play a game, play it through in one turn — act, observe, act again. Do not stop between moves to ask or report; if the game needs a second player and the user has not claimed a side, play both sides. Stop only when the game ends or you are truly stuck.
Get the user's approval before anything sensitive or irreversible: form submissions, purchases, deletions, credentials, or payments.

`.trim(),
);
