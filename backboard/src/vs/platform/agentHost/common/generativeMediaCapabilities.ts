/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a video model in the Backboard catalog accepts and produces, as far as
 * the Canvas generate bar needs to know: whether it can edit a video (video
 * in), animate an image (image in), and which lengths, resolutions and aspect
 * ratios it offers.
 */
export interface IVideoModelCapabilities {
	readonly acceptsVideo: boolean;
	readonly acceptsImage: boolean;
	/** Offered clip lengths in seconds, ascending; empty when the model sets it. */
	readonly durations: readonly number[];
	readonly resolutions: readonly string[];
	readonly aspectRatios: readonly string[];
	/** Whether the model can add native audio (dialogue, ambience) to the clip. */
	readonly generatesAudio: boolean;
	/** Rough USD cost of one second of output, when the catalog prices by the second. */
	readonly usdPerSecond: number | undefined;
}

/**
 * The picker description carries the capabilities after a fixed marker so the
 * people choosing a model read a summary (`Edits video · 4–30s · 720p`) and the
 * Canvas bar can read the same row back without a second catalog request.
 */
const CAPABILITIES_MARKER = '⁣';

/** Reads the capabilities of one `GET /models/video/all` entry. */
export function videoModelCapabilities(model: Record<string, unknown>): IVideoModelCapabilities {
	const inputs = isRecord(model.architecture) && Array.isArray(model.architecture.input_modalities)
		? model.architecture.input_modalities.filter((value): value is string => typeof value === 'string')
		: [];
	const acceptsVideo = model.supports_video_input === true || inputs.includes('video');
	const acceptsImage = inputs.includes('image') || (Array.isArray(model.supported_frame_images) && model.supported_frame_images.length > 0);
	const durations = Array.isArray(model.supported_durations)
		? [...new Set(model.supported_durations.filter((value): value is number => typeof value === 'number' && value > 0))].sort((a, b) => a - b)
		: [];
	return {
		acceptsVideo,
		acceptsImage,
		durations,
		resolutions: stringList(model.supported_resolutions),
		aspectRatios: stringList(model.supported_aspect_ratios),
		generatesAudio: model.generate_audio === true || model.supports_audio_output === true,
		usdPerSecond: usdPerSecond(model.pricing_skus),
	};
}

/**
 * The picker row description: a readable summary, then the machine-readable
 * capabilities behind an invisible separator.
 */
export function describeVideoModel(capabilities: IVideoModelCapabilities): string {
	const parts: string[] = [];
	if (capabilities.acceptsVideo) {
		parts.push('Edits video');
	} else if (capabilities.acceptsImage) {
		parts.push('Text or image to video');
	} else {
		parts.push('Text to video');
	}
	const durations = capabilities.durations;
	if (durations.length === 1) {
		parts.push(`${durations[0]}s`);
	} else if (durations.length > 1) {
		parts.push(`${durations[0]}–${durations[durations.length - 1]}s`);
	}
	if (capabilities.resolutions.length) {
		parts.push(capabilities.resolutions.join('/'));
	}
	return `${parts.join(' · ')}${CAPABILITIES_MARKER}${JSON.stringify({
		v: capabilities.acceptsVideo ? 1 : 0,
		i: capabilities.acceptsImage ? 1 : 0,
		d: capabilities.durations,
		r: capabilities.resolutions,
		a: capabilities.aspectRatios,
		s: capabilities.generatesAudio ? 1 : 0,
		p: capabilities.usdPerSecond,
	})}`;
}

/** The human part of a {@link describeVideoModel} description. */
export function videoModelSummary(description: string | undefined): string | undefined {
	return description?.split(CAPABILITIES_MARKER)[0] || undefined;
}

/** Reads back what {@link describeVideoModel} encoded, or `undefined` for a plain description. */
export function parseVideoModelDescription(description: string | undefined): IVideoModelCapabilities | undefined {
	const index = description?.indexOf(CAPABILITIES_MARKER) ?? -1;
	if (!description || index < 0) {
		return undefined;
	}
	try {
		const data: unknown = JSON.parse(description.slice(index + CAPABILITIES_MARKER.length));
		if (!isRecord(data)) {
			return undefined;
		}
		return {
			acceptsVideo: data.v === 1,
			acceptsImage: data.i === 1,
			durations: Array.isArray(data.d) ? data.d.filter((value): value is number => typeof value === 'number') : [],
			resolutions: stringList(data.r),
			aspectRatios: stringList(data.a),
			generatesAudio: data.s === 1,
			usdPerSecond: typeof data.p === 'number' ? data.p : undefined,
		};
	} catch {
		return undefined;
	}
}

/**
 * Per-second price from the catalog's pricing SKUs. Catalogs price in several
 * shapes (`duration_seconds`, `duration_seconds_720p`, `cents_per_second_output`
 * …); only those are read, and the cheapest listed rate is used as the floor
 * of an estimate. Token-priced models return `undefined`.
 */
function usdPerSecond(skus: unknown): number | undefined {
	if (!isRecord(skus)) {
		return undefined;
	}
	const rates: number[] = [];
	for (const [key, raw] of Object.entries(skus)) {
		const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
		if (!isFinite(value) || value <= 0) {
			continue;
		}
		if (/^cents_per_(?:video_output_)?second/.test(key)) {
			rates.push(value / 100);
		} else if (/(?:^|_)duration_seconds(?:_|$)/.test(key)) {
			rates.push(value);
		}
	}
	return rates.length ? Math.min(...rates) : undefined;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
