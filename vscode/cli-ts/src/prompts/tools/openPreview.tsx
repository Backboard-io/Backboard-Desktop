import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const openPreview: PromptModule = definePrompt(
	`Announce a local web app so the user gets a live preview of it.

Call OpenPreview whenever you start a local dev server or want to show the user a web app running on localhost — e.g. right after \`npm run dev\`, \`vite\`, \`next dev\`, or \`python -m http.server\` reports its URL. The host surfaces the URL to the user (in the Backboard IDE: a preview card in the chat and the built-in browser).

Guidelines:
- Pass the exact URL the server printed, including the port (e.g. http://localhost:5173).
- Call it once per app; call it again only if the app moves to a different port.
- The result reports whether anything responded at the URL. If the server was not reachable yet, verify it is actually running before telling the user it works.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`url\` | \`string\` | yes | URL of the local web app, e.g. http://localhost:3000. |`.trim(),
);
