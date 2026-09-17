import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const generateVideo: PromptModule = definePrompt(
	`Generate a video with Backboard's built-in generate_video tool.

Use this whenever the user asks for a clip and the composer's Video picker is on. Call this function directly — do not search docs or MCP to check capability first, and do not use execute, curl, FetchUrl, a provider SDK, or POST /threads/messages to generate video.

Arguments:
- prompt: the scene to generate.
- duration, resolution, generate_audio, and aspect_ratio only when the user asked for them.
- images: local paths of reference images the user attached, when they provided them.

Do not pass a model. The Video picker already selected it for this turn, and Backboard pins it on the tool call. If that model cannot satisfy the request, say so instead of substituting another model or falling back to a shell.
`.trim(),
);
