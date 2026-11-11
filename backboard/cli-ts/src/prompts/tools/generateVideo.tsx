import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const generateVideo: PromptModule = definePrompt(
	`Generate a video with Backboard's built-in generate_video tool.

Use this whenever the user asks for a clip and the composer's Video picker is on. Call this function directly — do not search docs or MCP to check capability first, and do not use execute, curl, FetchUrl, a provider SDK, or POST /threads/messages to generate video. When Ask Before Generating is on, confirm the generation with the user first, as the system prompt describes.

Arguments:
- prompt: the scene to generate.
- video_config: requested duration, resolution, generate_audio, and aspect_ratio, using only settings exposed by the selected tool's schema. These are nested settings, not top-level tool arguments. Preserve source duration and resolution for edits and upscales unless the user requests a supported change.
- Omit unused optional settings and input fields instead of sending null. Do not add size, seed, or provider routing unless the user requested them. Omit video_config entirely when no output settings are needed.
- Attached media arrives as document IDs, not paths. For a source-video edit or upscale, use input_video_document_id when exposed by the selected tool and describe only the requested change. Do not move a required source clip into input_reference_document_ids. Reference-guided generation makes a new clip; use input_reference_document_ids only when the tool exposes it and the user wants that operation. Follow the selected tool's model-specific guidance instead of assuming all models from a provider have the same capabilities.
- Use input_image_document_id and input_last_frame_document_id only for the roles the selected tool describes: animation frames or an edited first-frame keyframe. Do not combine frames and references unless supported.

Do not pass a model. The Video picker already selected it for this turn, and Backboard pins it on the tool call. If that model cannot satisfy the request, say so instead of substituting another model or falling back to a shell.
`.trim(),
);
