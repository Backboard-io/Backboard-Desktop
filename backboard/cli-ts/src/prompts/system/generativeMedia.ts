import type { ModelSource } from "../../providers/backboard/types.ts";

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
	/**
	 * Where the turn is billed. Backboard's media tools only run on
	 * Backboard-billed turns; a key or subscription turn never reaches them.
	 */
	route?: { source: ModelSource; provider: string };
	/**
	 * The composer's "Ask Before Generating" switch: confirm each generation
	 * with the user (via `ask_user`) before it spends Backboard credits.
	 */
	askBeforeGenerating?: boolean;
	/** The working directory is a Backboard Canvas project (see {@link CANVAS_PROJECT_FILE}). */
	canvasProject?: boolean;
	/** The project's defaults for new media, from its board file. */
	canvasSettings?: CanvasProjectSettings;
}

/** Defaults the Canvas window stores under `settings` in the board file. */
export interface CanvasProjectSettings {
	aspectRatio?: string;
	duration?: number;
	resolution?: string;
	audio?: boolean;
}

/** Reads the `settings` of a Canvas board file; malformed files give none. */
export function parseCanvasProjectSettings(
	text: string,
): CanvasProjectSettings | undefined {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return undefined;
	}
	const raw =
		typeof data === "object" && data !== null
			? (data as { settings?: unknown }).settings
			: undefined;
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const value = raw as Record<string, unknown>;
	const settings: CanvasProjectSettings = {
		...(typeof value.aspectRatio === "string"
			? { aspectRatio: value.aspectRatio }
			: {}),
		...(typeof value.duration === "number" && value.duration > 0
			? { duration: value.duration }
			: {}),
		...(typeof value.resolution === "string"
			? { resolution: value.resolution }
			: {}),
		...(typeof value.audio === "boolean" ? { audio: value.audio } : {}),
	};
	return Object.keys(settings).length ? settings : undefined;
}

/**
 * Marks a folder as a Canvas project: the IDE's Canvas window keeps its board
 * here. Mirrored as CANVAS_BOARD_FILE in the IDE
 * (src/vs/sessions/contrib/canvasStudio/common/canvasBoard.ts).
 */
export const CANVAS_PROJECT_FILE = ".backboard/canvas.json";

export function buildGenerativeMediaPrompt(
	selection: GenerativeMediaSelection,
): string {
	const media = buildMediaToolsPrompt(selection);
	if (!selection.canvasProject) {
		return media;
	}
	const defaults = describeCanvasSettings(selection.canvasSettings);
	return `${media}\n\n${CANVAS_PROJECT_PROMPT}${defaults ? `\n- ${defaults}` : ""}`;
}

/** "Project defaults for new clips: 16:9, 8 seconds, 720p, native audio on." */
function describeCanvasSettings(
	settings: CanvasProjectSettings | undefined,
): string | undefined {
	if (!settings) {
		return undefined;
	}
	const parts = [
		settings.aspectRatio,
		settings.duration ? `${settings.duration} seconds` : undefined,
		settings.resolution,
		settings.audio === undefined
			? undefined
			: settings.audio
				? "native audio on"
				: "no audio",
	].filter((part): part is string => !!part);
	return parts.length
		? `Project defaults for new clips (chosen in the Canvas settings under the chat): ${parts.join(", ")}. Use them, and do not ask for a length, unless the user asks for something else.`
		: undefined;
}

/**
 * The Canvas window is a Runway-style studio: the user watches a board that
 * places every generated or edited clip next to its source. The agent's job
 * there is to make media, and to edit by describing only the change.
 */
const CANVAS_PROJECT_PROMPT = [
	"## Canvas project",
	"",
	"In this folder you are the user's creative studio agent, not a coding assistant: introduce yourself and answer as a director and editor who makes images and videos. The folder is a Backboard Canvas project, and every image or video you generate, and every media file saved in it, appears on the user's board as you work, next to the media it came from.",
	"- Make the media. When the user asks for a shot, an ad or an edit, generate it with the media tools instead of describing what you would do.",
	'- Edits: when an image or video is attached and the user asks for a change ("replace the dog with a cat", "make it night"), generate from that attachment and write the prompt as "keep everything about the shot identical" plus only the change. Do not regenerate from scratch unless asked.',
	"- Editing a video needs a video model that accepts video input (for example Runway Aleph or FLUX Video Edit); animating an image needs one that accepts a first frame. If the selected model cannot take the attachment, say which kind of model can instead of switching models.",
	"- Longer pieces (ads, trailers, stories): propose a short shot list first, one line per shot with its length, then generate shot by shot and reuse earlier stills as references so characters and places stay consistent.",
	"- Keep every output inside this project folder. Never edit or delete `.backboard/canvas.json`; the board arranges itself.",
].join("\n");

function buildMediaToolsPrompt(selection: GenerativeMediaSelection): string {
	if (selection.route && selection.route.source !== "backboard") {
		return buildOwnBillingMediaPrompt(selection.route);
	}
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
			? `For video, you must call \`generate_video\` ${selection.askBeforeGenerating ? "yourself once the user approves (see Ask Before Generating below)" : "directly"} — do not search docs, MCP, or the web to check capability first; the tool is available right now. Never use execute, curl, FetchUrl, or POST /threads/messages to create a clip. Fill \`prompt\` and optional duration/resolution/native audio; Backboard supplies the selected model.`
			: "Ask for the media in natural language and let the thread model call the tool.",
		...(videoModel ? ["", VIDEO_LENGTH_GUIDANCE, "", attachedMediaGuidance(videoModel.provider)] : []),
		"",
		"The selected model is fixed for the turn. Never substitute another media model. If the selected model cannot satisfy the request — an unsupported duration or input, for instance — say so and offer a supported alternative instead of switching models.",
		...(selection.askBeforeGenerating ? ["", ASK_BEFORE_GENERATING_GUIDANCE] : []),
	].join("\n");
}

/**
 * Answers offered by the "Ask Before Generating" confirmation card. The
 * hosted media tools run server-side where the client cannot interject, so
 * the agent itself must stop and ask before it spends credits.
 */
export const ASK_BEFORE_GENERATING_OPTIONS = ["Generate", "Change something"] as const;

const ASK_BEFORE_GENERATING_GUIDANCE = [
	"### Ask Before Generating",
	"",
	"Ask Before Generating is on: the user approves every generation before it spends Backboard credits.",
	`- Before calling \`generate_image\` or \`generate_video\`, call \`ask_user\` once with one question — header "Confirm generation", options ${ASK_BEFORE_GENERATING_OPTIONS.map((option) => `"${option}"`).join(", ")}. Make the question a short summary of what you will generate: the model, what the image or clip will show (a one-line version of your prompt), the inputs you will use (attached images or clips), and for video the length, resolution, aspect ratio and audio. End it with a credit note: generating uses Backboard credits, video costs more than images, and longer or higher-resolution clips cost more. Never quote a price you do not know.`,
	'- Call the media tool only after the user answers "Generate" or otherwise clearly approves. If they choose "Change something" or type a change, apply it (ask what to change if they did not say) and confirm the revised request the same way. If they decline, do not generate.',
	'- If you also need the video length, put the "Video length" question first in that same `ask_user` call, so the user answers once.',
	"- One approval covers the whole request: when you propose several images or a shot list, confirm the full set at once, then generate every item without asking again. Retrying an approved generation after a failure (for example following the tool's `hint`) with the same inputs needs no new confirmation; ask again only for a new or changed generation.",
	"- A request to make media is not approval by itself. If the user wants to stop confirming, tell them to turn off Ask Before Generating in the composer's + menu.",
].join("\n");

/**
 * Media on a turn billed to the user's own key or plan. Backboard's tools
 * would bill a second account, so they are off; a ChatGPT plan still carries
 * OpenAI's hosted image tool (see CodexSubscriptionClient).
 */
function buildOwnBillingMediaPrompt(route: {
	source: ModelSource;
	provider: string;
}): string {
	const noShellMedia =
		"Do not generate media with execute, curl, FetchUrl, or a provider SDK.";
	if (route.provider === "openai-subscription") {
		return [
			"## Image and video generation",
			"",
			"This turn runs on the user's ChatGPT subscription, so Backboard's `generate_image` / `generate_video` tools are not available.",
			"- Images: use your built-in image generation tool when the user asks for an image. It runs on the subscription; each image is shown to the user and saved in the project's `generated-images/` folder automatically.",
			"- Videos: not available on this model. If the user asks for a clip, tell them video generation needs a Backboard model.",
			"",
			noShellMedia,
		].join("\n");
	}
	const billing =
		route.source === "byok"
			? "the user's own API key"
			: route.provider === "anthropic-subscription"
				? "the user's Claude subscription"
				: "the user's own subscription";
	return [
		"## Image and video generation",
		"",
		`Media generation is not available on this model: it runs on ${billing}, and Backboard's \`generate_image\` / \`generate_video\` tools only run on Backboard models. If the user asks for an image or a video, tell them to switch to a Backboard model.`,
		"",
		noShellMedia,
	].join("\n");
}

/**
 * Clip length is the one video setting users care about up front, and the
 * hosted `generate_video` tool runs server-side where the client cannot
 * interject. So the agent asks first (the composer shows `ask_user` as a
 * question card) unless the user already said how long.
 */
// Mirrored as VIDEO_LENGTH_SECONDS in the IDE's Canvas composer
// (src/vs/sessions/contrib/rightWorkbench/browser/rightWorkbenchCanvas.ts),
// which cannot import cli-ts — change both together.
export const VIDEO_LENGTH_OPTIONS = ["5s", "8s", "10s", "15s"] as const;

/**
 * How the video tool takes the user's attached media: uploaded with the
 * message and offered to `generate_video` as document IDs. Without this the
 * agent read a clip with Read (binary into context), guessed among IDs, and
 * silently regenerated from scratch when an edit failed.
 *
 * OpenRouter (every video model the picker lists today) has no source-video
 * field: the clip goes in as a video *reference* (`input_references` with a
 * `video_url`). Live tests (2026-10-02) showed which models take one: Hailuo 3
 * (clip alone or clip plus images, e.g. "the man at the mic is the fox from
 * the reference image"), Aleph 2 and FLUX Video Edit (clip alone). Seedance
 * failed on every video input however the prompt was worded, and references
 * past ~10s or above 720p failed everywhere.
 */
function attachedMediaGuidance(videoProvider: string): string {
	const sourceClip = videoProvider === "openrouter"
		? [
			"pass that clip in the references (`input_reference_document_ids`), together with any attached images that should appear in it, not `input_video_document_id` (this provider has no source-video field).",
			"Write the prompt as a new video that follows the reference, never as an edit of it: describe the whole shot you want (subject, action, setting) with the user's change built in, say it follows the reference video's camera motion, framing, movement and scene, and name which reference image becomes which person or object. For example, \"The man at the microphone is the fox character from the reference image, rapping with the same gestures; follows the reference video's camera motion, framing, the other performer and the studio.\"",
			"Only Hailuo 3 takes a clip plus images; Aleph 2 and FLUX Video Edit take a clip alone; Seedance models take no video input at all. If the selected model cannot take what the user attached, say so and name a model that can instead of calling the tool.",
		].join(" ")
		: "pass that clip as the source video (`input_video_document_id`) and describe only the change.";
	return [
		"Attached media: images and videos the user attaches are uploaded with their message and reach `generate_video` as document IDs, not file paths. Never open attached images or videos with Read or other file tools; they are binary.",
		`- To edit, restyle, extend or continue an attached video ("change the jerseys", "make it night", "replace him with @image_2"), ${sourceClip} Use first/last-frame images only to animate a still.`,
		"- The user's attachment is the file their message names. If several document IDs are offered and you cannot tell which one it is, prefer the one uploaded with this message and say which you used.",
		"- If `generate_video` fails with a `hint`, follow it and retry once with the same inputs. Otherwise tell the user the tool's error and what you passed. Do not quietly switch to generating a new clip from scratch, or from a still of the clip; offer that as an option instead.",
	].join("\n");
}

const VIDEO_LENGTH_GUIDANCE = `Video length: if the user has not said how long the clip should be (e.g. "10 seconds", "a 5s clip", "short"), call \`ask_user\` before \`generate_video\` with one question — header "Video length", question "How long should the video be?", options ${VIDEO_LENGTH_OPTIONS.map((option) => `"${option}"`).join(", ")} — then pass the chosen length as \`duration\` in seconds. If they already gave a length, use it (as \`duration\`) without asking. Always state the clip length in your reply once the video is ready.`;

function formatSelection(selection: {
	provider: string;
	name: string;
}): string {
	return `${selection.provider}/${selection.name}`;
}
