import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const generateVideo: PromptModule = definePrompt(
	`Generate a video with Backboard's built-in generate_video tool.

Use this whenever the user asks for a clip and the composer's Video picker is on. Call this function directly — do not search docs or MCP to check capability first, and do not use execute, curl, FetchUrl, a provider SDK, or POST /threads/messages to generate video.

Arguments:
- prompt: the scene to generate.
- duration, resolution, generate_audio, and aspect_ratio only when the user asked for them.
- Attached media arrives as document IDs, not paths. On OpenRouter models (the Video picker's openrouter/… models) a clip to change or extend goes in the references (input_reference_document_ids), not input_video_document_id. Describe the new video in full, following the reference video's camera motion, framing, movement and scene, with the change built in. Never word it as an edit ("keep the same footage", "change only", "replace"): Seedance then switches to a video-editing mode OpenRouter cannot run, and the job fails. Pass a still to animate as the first frame.

Do not pass a model. The Video picker already selected it for this turn, and Backboard pins it on the tool call. If that model cannot satisfy the request, say so instead of substituting another model or falling back to a shell.
`.trim(),
);
