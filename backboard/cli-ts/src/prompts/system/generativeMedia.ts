/**
 * Tells the agent which built-in media tools this turn enables.
 *
 * The composer's Image/Video pickers are authoritative. Image and video
 * generation are Backboard's hosted tools, activated by the
 * `image_generation` / `video_generation` request fields; without this note
 * an agent that cannot see them tends to call the media HTTP API from a
 * shell, which silently generates with a model the user never chose.
 */
export interface GenerativeMediaSelection {
	imageModel?: { provider: string; name: string };
	videoModel?: { provider: string; name: string };
}

export function buildGenerativeMediaPrompt(
	selection: GenerativeMediaSelection,
): string {
	const { imageModel, videoModel } = selection;
	if (!imageModel && !videoModel) {
		return [
			"## Image and video generation",
			"",
			"Media generation is off for this turn: no image or video model is selected in the composer, so Backboard's built-in `generate_image` / `generate_video` tools are unavailable. If the user asks for media, tell them to enable the model in the composer's plus menu rather than choosing a media model yourself.",
			"",
			"Do not search docs, MCP, or the web to research media capability — the picker is the capability. Do not generate media with execute, curl, FetchUrl, or a provider SDK.",
		].join("\n");
	}
	const enabled: string[] = [];
	if (imageModel) {
		enabled.push(
			`- Images: \`generate_image\` with \`${formatSelection(imageModel)}\`.`,
		);
	}
	if (videoModel) {
		enabled.push(
			`- Videos: call the \`generate_video\` function tool. The Video picker already selected \`${formatSelection(videoModel)}\`; that model is pinned on the tool call, so do not pass a model argument.`,
		);
	}
	return [
		"## Image and video generation",
		"",
		"Backboard's built-in media tools are enabled for this turn:",
		...enabled,
		"",
		videoModel
			? "For video, you must call `generate_video` directly — do not search docs, MCP, or the web to check capability first; the tool is available right now. Never use execute, curl, FetchUrl, or POST /threads/messages to create a clip. Fill `prompt` and optional duration/resolution/native audio; Backboard supplies the selected model."
			: "Ask for the media in natural language and let the thread model call the tool.",
		"",
		"The selected model is fixed for the turn. Never substitute another media model. If the selected model cannot satisfy the request — an unsupported duration or input, for instance — say so and offer a supported alternative instead of switching models.",
	].join("\n");
}

function formatSelection(selection: {
	provider: string;
	name: string;
}): string {
	return `${selection.provider}/${selection.name}`;
}
