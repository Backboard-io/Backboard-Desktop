/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { backboardApiBaseUrl, backboardConfigAccessToken, backboardConfigApiKey, backboardConfigResource, normalizeBackboardEnv, readBackboardConfigJson } from '../../../../workbench/contrib/chat/common/backboardAuth.js';
import { CANVAS_UPSCALE_FACTOR, CanvasEditTool, ICanvasEditModel, ICanvasEditRequest, ICanvasImage } from './rightWorkbenchCanvas.js';

/**
 * Canvas's editing tools, Higgsfield's "Edit Video" tab: each runs a source
 * clip through a model that edits footage (rather than generating new video
 * guided by it) by calling Backboard's stateless media API directly, so no
 * chat model sits between the user and the edit.
 *
 * The models are the ones that passed live tests through Backboard
 * (2026-10-02/03): Aleph 2 kept the original footage, timing and audio while
 * replacing people and the set; FLUX Video Edit handled clips up to 10s.
 * Seedance's edit mode is not reachable through OpenRouter.
 */
export const CANVAS_EDIT_MODELS: Readonly<Record<CanvasEditTool, readonly ICanvasEditModel[]>> = {
	edit: [
		{ id: 'runway/aleph-2', label: 'Runway Aleph 2', maxSeconds: 30, centsPerSecond: 28, minimumCents: 56, takesReferences: true, keepsAudio: true },
		{ id: 'black-forest-labs/flux-video-edit', label: 'FLUX Video Edit', maxSeconds: 10, centsPerSecond: 3 },
	],
	upscale: [
		{ id: 'black-forest-labs/flux-video-upscale', label: 'FLUX Video Upscale', maxSeconds: 10, centsPerMegapixelSecond: 7.5 },
	],
	extend: [
		{ id: 'black-forest-labs/flux-3-video', label: 'FLUX.3 Video', maxSeconds: 20, centsPerSecond: 41 },
	],
};

/** The image model that edits a clip's first frame with the user's reference photos. */
const FRAME_EDIT_MODEL = 'google/gemini-3.1-flash-image';

/** A 200x200 reference photo made generation fail where the same photo at 600x600 worked: smaller photos are scaled up to this short edge. */
const REFERENCE_MIN_EDGE = 600;

/**
 * Each edit is recorded beside uploads as `<time>-<name>.json`: how it was
 * made and the link Backboard returned. Canvas shows the result from that
 * link, like the chat shows generated media; it is never downloaded.
 */
export const CANVAS_EDITS_FOLDER = 'canvas-edits';

/** How an edit was made, and where its result is. */
export interface ICanvasEditRecord {
	/** The result as Backboard returned it. */
	readonly url: string;
	readonly tool: CanvasEditTool;
	readonly model: string;
	readonly prompt: string;
	readonly source: string;
	/** Set when reference photos were asked for but the API could not take the guide frame. */
	readonly referencesDropped?: boolean;
}

export interface ICanvasEditServices {
	readonly fileService: IFileService;
	readonly pathService: IPathService;
	readonly configurationService: IConfigurationService;
}

export class CanvasEditError extends Error { }

interface IBackboardApi {
	readonly baseUrl: string;
	readonly headers: Record<string, string>;
}

async function backboardApi({ fileService, pathService, configurationService }: ICanvasEditServices): Promise<IBackboardApi> {
	const config = await readBackboardConfigJson(fileService, await backboardConfigResource(pathService));
	const setting = (key: string) => {
		const value = configurationService.getValue(key);
		return typeof value === 'string' && value.trim() ? value.trim() : undefined;
	};
	const apiKey = setting('backboard.apiKey') ?? backboardConfigApiKey(config);
	const accessToken = backboardConfigAccessToken(config);
	if (!apiKey && !accessToken) {
		throw new CanvasEditError(localize('canvasEdits.signIn', "Sign in to Backboard to edit videos."));
	}
	const configuredUrl = setting('backboard.apiUrl') ?? (typeof config.api_url === 'string' ? config.api_url : undefined);
	const env = normalizeBackboardEnv(typeof config.env === 'string' ? config.env : setting('backboard.env'));
	return {
		baseUrl: backboardApiBaseUrl(config, configuredUrl, env).replace(/\/+$/, ''),
		headers: apiKey ? { 'X-API-Key': apiKey } : { 'Authorization': `Bearer ${accessToken}` },
	};
}

/** An item's bytes, from its file on disk: Canvas edits only what is saved locally (an upload or a saved copy). */
async function readItem(image: ICanvasImage, { fileService }: ICanvasEditServices): Promise<Blob> {
	const file = image.localFile ?? (image.src.scheme === Schemas.file ? image.src : undefined);
	if (!file) {
		throw new CanvasEditError(localize('canvasEdits.notLocal', "{0} isn't saved on this computer. Upload it to Canvas first, then edit it.", image.label));
	}
	const content = (await fileService.readFile(file)).value;
	return new Blob([content.buffer.slice()], { type: image.kind === 'video' ? 'video/mp4' : imageType(file.path) });
}

function imageType(path: string): string {
	const extension = path.split('.').pop()?.toLowerCase();
	return extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : 'image/png';
}

/** Draws `source` (an image or the first frame of a video) to a PNG, scaled so its short edge is at least `minEdge`. */
async function toPng(source: Blob, kind: ICanvasImage['kind'], targetWindow: Window & typeof globalThis, minEdge = 0): Promise<Blob> {
	const url = URL.createObjectURL(source);
	try {
		let drawable: CanvasImageSource;
		let width: number;
		let height: number;
		if (kind === 'video') {
			const video = targetWindow.document.createElement('video');
			video.muted = true;
			video.preload = 'auto';
			video.src = url;
			await new Promise<void>((resolve, reject) => {
				video.addEventListener('loadeddata', () => resolve(), { once: true });
				video.addEventListener('error', () => reject(new CanvasEditError(localize('canvasEdits.frameFailed', "Could not read the video's first frame."))), { once: true });
			});
			drawable = video;
			width = video.videoWidth;
			height = video.videoHeight;
		} else {
			const bitmap = await targetWindow.createImageBitmap(source);
			drawable = bitmap;
			width = bitmap.width;
			height = bitmap.height;
		}
		const scale = Math.max(1, minEdge / Math.min(width, height));
		const canvas = new targetWindow.OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
		canvas.getContext('2d')?.drawImage(drawable, 0, 0, canvas.width, canvas.height);
		return await canvas.convertToBlob({ type: 'image/png' });
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** A media item from a stateless generation's SSE stream, or the stream's error. */
async function postGeneration(api: IBackboardApi, form: FormData, token: AbortSignal | undefined): Promise<string> {
	form.append('stream', 'true');
	const response = await fetch(`${api.baseUrl}/threads/messages`, { method: 'POST', headers: api.headers, body: form, signal: token });
	if (!response.ok || !response.body) {
		throw new CanvasEditError(apiErrorText(response.status, await response.text()));
	}
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = '';
	let url: string | undefined;
	let error: string | undefined;
	for (; ;) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		buffer += value;
		let newline: number;
		while ((newline = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line.startsWith('data:')) {
				continue;
			}
			let event: { type?: string; media?: { url?: string }; error?: string };
			try {
				event = JSON.parse(line.slice(5));
			} catch {
				continue;
			}
			if (event.type === 'media_generated' && event.media?.url) {
				url = event.media.url;
			} else if (event.type === 'error') {
				error = event.error;
			}
		}
	}
	if (!url) {
		throw new CanvasEditError(error && error !== 'Media generation failed'
			? error
			: localize('canvasEdits.failed', "The model couldn't make this edit. Shorter clips, a different model, or a simpler change usually work."));
	}
	return url;
}

function apiErrorText(status: number, body: string): string {
	let detail: string | undefined;
	try {
		const parsed = JSON.parse(body);
		detail = typeof parsed?.detail === 'string' ? parsed.detail : undefined;
	} catch {
		// Not JSON.
	}
	if (status === 402) {
		return localize('canvasEdits.credits', "Not enough Backboard credits for this edit.");
	}
	return detail && status < 500 ? detail : localize('canvasEdits.http', "Backboard couldn't start the edit (HTTP {0}).", status);
}

/** Whether a 400 means the API does not yet pass provider options (Aleph's guide frame) through for video. */
function rejectsProviderOptions(error: unknown): boolean {
	return error instanceof CanvasEditError && /options/i.test(error.message) && /provider/i.test(error.message);
}

/**
 * Runs one edit and saves its result. With reference photos on Aleph, the
 * clip's first frame is first edited with the photos (an image model), then
 * pinned as Aleph's guide frame so the change carries through the footage;
 * when the API cannot pass the guide frame yet, the edit runs from the text.
 */
export async function runCanvasEdit(request: ICanvasEditRequest, model: ICanvasEditModel, services: ICanvasEditServices, targetWindow: Window & typeof globalThis, token?: AbortSignal): Promise<ICanvasEditRecord> {
	const api = await backboardApi(services);
	const video = await readItem(request.video, services);
	const photos = request.tool === 'edit' && model.takesReferences ? request.references.filter(image => image.kind === 'image') : [];
	const videoForm = (keyframe: string | undefined) => {
		const form = new FormData();
		form.append('operation', 'generate_video');
		form.append('content', request.prompt || (request.tool === 'upscale' ? 'Upscale this video faithfully.' : 'Continue this shot.'));
		form.append('video_model_provider', 'openrouter');
		form.append('video_model_name', model.id);
		const config: Record<string, unknown> = {};
		if (request.tool === 'upscale') {
			config.upscale_factor = CANVAS_UPSCALE_FACTOR;
			config.creativity = 0;
		} else if (request.tool === 'extend') {
			config.duration = request.seconds ?? 5;
			config.resolution = '720p';
		}
		if (keyframe) {
			config.provider = { options: { runway: { parameters: { keyframes: [{ uri: keyframe, position: 'first' }] } } } };
		}
		if (Object.keys(config).length) {
			form.append('video_config', JSON.stringify(config));
		}
		form.append('input_video', new File([video], `${basename(request.video.localFile ?? request.video.src) || 'source'}.mp4`, { type: 'video/mp4' }));
		return form;
	};

	let keyframe: string | undefined;
	if (photos.length) {
		const frame = await toPng(video, 'video', targetWindow);
		const form = new FormData();
		form.append('operation', 'generate_image');
		form.append('content', `Edit this frame from a video. Keep the exact camera angle, framing, composition, lighting direction and every person's pose. ${request.prompt} The reference photos show who or what to use. Photorealistic, same film look.`);
		form.append('image_model_provider', 'openrouter');
		form.append('image_model_name', FRAME_EDIT_MODEL);
		form.append('input_image', new File([frame], 'frame.png', { type: 'image/png' }));
		for (const [index, photo] of photos.entries()) {
			const png = await toPng(await readItem(photo, services), 'image', targetWindow, REFERENCE_MIN_EDGE);
			form.append('input_references', new File([png], `reference-${index + 1}.png`, { type: 'image/png' }));
		}
		keyframe = await postGeneration(api, form, token);
	}

	let url: string;
	let referencesDropped = false;
	try {
		url = await postGeneration(api, videoForm(keyframe), token);
	} catch (error) {
		if (!keyframe || !rejectsProviderOptions(error)) {
			throw error;
		}
		// Backboard does not pass Aleph's guide frame through yet: edit from the text alone.
		referencesDropped = true;
		url = await postGeneration(api, videoForm(undefined), token);
	}

	const record: ICanvasEditRecord = {
		url,
		tool: request.tool,
		model: model.id,
		prompt: request.prompt,
		source: request.video.label,
		...(referencesDropped ? { referencesDropped } : {}),
	};
	const folder = URI.joinPath(await services.pathService.userHome(), '.backboard', CANVAS_EDITS_FOLDER);
	const name = `${Date.now()}-${request.tool}-${slug(request.prompt || request.video.label)}`;
	await services.fileService.writeFile(URI.joinPath(folder, `${name}.json`), VSBuffer.fromString(JSON.stringify(record, undefined, '\t')));
	return record;
}

function slug(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'edit';
}
