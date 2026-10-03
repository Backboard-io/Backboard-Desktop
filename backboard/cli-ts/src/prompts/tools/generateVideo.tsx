import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const generateVideo: PromptModule = definePrompt(
	`Generate a video with Backboard's built-in generate_video tool.

Use this whenever the user asks for a clip and the composer's Video picker is on. Call this function directly — do not search docs or MCP to check capability first, and do not use execute, curl, FetchUrl, a provider SDK, or POST /threads/messages to generate video.

Arguments:
- prompt: the scene to generate.
- duration, resolution, generate_audio, and aspect_ratio only when the user asked for them.
- Attached media arrives as document IDs, not paths. On OpenRouter models (the Video picker's openrouter/… models) a clip to change or extend goes in the references (input_reference_document_ids), with any images that should appear in it, not input_video_document_id. Describe the new video in full, following the reference video's camera motion, framing, movement and scene, with the change built in and each reference image named for what it becomes. Only Hailuo 3 takes a clip plus images; Aleph 2 and FLUX Video Edit take a clip alone; Seedance takes no video input. Pass a still to animate as the first frame.

Do not pass a model. The Video picker already selected it for this turn, and Backboard pins it on the tool call. If that model cannot satisfy the request, say so instead of substituting another model or falling back to a shell.
`.trim(),
);
