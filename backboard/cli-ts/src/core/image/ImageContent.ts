/**
 * Standardized, global representation of image content emitted by tools and
 * runtimes (file reads, computer screenshots, browser screenshots, and any
 * future image-producing surface).
 *
 * All image-producing code paths build their wire payload through this class
 * so the on-the-wire contract (`__image_base64` / `__image_media_type`) is
 * defined in exactly one place. The server side inspects the active model's
 * vision capability and either forwards the image to the model or routes it
 * through a vision model for text extraction — but the client only needs to
 * emit a single, consistent shape.
 */

import { PNG } from "pngjs";

/** Canonical wire-protocol field keys. Defined once, referenced everywhere. */

export const IMAGE_PAYLOAD_BASE64_KEY = "__image_base64" as const;
export const IMAGE_PAYLOAD_MEDIA_TYPE_KEY = "__image_media_type" as const;

/**
 * The standardized image payload embedded into tool results / observations.
 * Generic over the media-type so callers that use a fixed type (e.g. always
 * PNG screenshots) keep their narrow literal type.
 */
export interface ImageContentPayload<M extends string = string> {
	__image_base64: string;
	__image_media_type: M;
}

// biome-ignore lint/complexity/noStaticOnlyClass: intentional namespaced image API
export class ImageContent {
	/** Build a standardized payload from raw bytes. */
	static fromBytes<M extends string>(
		bytes: Buffer | Uint8Array,
		mediaType: M,
	): ImageContentPayload<M> {
		const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
		return ImageContent.fromBase64(buffer.toString("base64"), mediaType);
	}

	/** Build a standardized payload from an already base64-encoded string. */
	static fromBase64<M extends string>(
		base64: string,
		mediaType: M,
	): ImageContentPayload<M> {
		if (mediaType === "image/png") {
			base64 = normalizeSmallPng(base64);
		}
		return {
			[IMAGE_PAYLOAD_BASE64_KEY]: base64,
			[IMAGE_PAYLOAD_MEDIA_TYPE_KEY]: mediaType,
		} as ImageContentPayload<M>;
	}

	/** Render a payload as a `data:` URI. */
	static toDataUri(payload: ImageContentPayload): string {
		return `data:${payload.__image_media_type};base64,${payload.__image_base64}`;
	}

	/** Type guard: does an arbitrary value carry a standardized image payload? */
	static isImagePayload(value: unknown): value is ImageContentPayload {
		return (
			typeof value === "object" &&
			value !== null &&
			typeof (value as Record<string, unknown>)[IMAGE_PAYLOAD_BASE64_KEY] ===
				"string" &&
			typeof (value as Record<string, unknown>)[
				IMAGE_PAYLOAD_MEDIA_TYPE_KEY
			] === "string"
		);
	}
}

/** Vision requires each side >= 8px and area >= 512px; preserve the source file. */
function normalizeSmallPng(base64: string): string {
	// Inspect just the PNG header so normal screenshots avoid another full decode.
	const header = Buffer.from(base64.slice(0, 32), "base64");
	if (
		header.length < 24 ||
		header.readUInt32BE(0) !== 0x89504e47 ||
		header.toString("ascii", 12, 16) !== "IHDR"
	)
		return base64;
	const width = header.readUInt32BE(16);
	const height = header.readUInt32BE(20);
	if (width >= 8 && height >= 8 && width * height >= 512) return base64;
	if (!width || !height) throw new Error("Invalid PNG dimensions");
	const scale = Math.ceil(
		Math.max(8 / width, 8 / height, Math.sqrt(512 / (width * height))),
	);
	const targetWidth = width * scale;
	const targetHeight = height * scale;
	if (targetWidth * targetHeight > 16_000_000)
		throw new Error("PNG is too large to resize for vision");
	const source = PNG.sync.read(Buffer.from(base64, "base64"));
	const target = new PNG({ width: targetWidth, height: targetHeight });
	for (let y = 0; y < targetHeight; y++) {
		for (let x = 0; x < targetWidth; x++) {
			const sourceOffset =
				(Math.floor(y / scale) * width + Math.floor(x / scale)) * 4;
			source.data.copy(
				target.data,
				(y * targetWidth + x) * 4,
				sourceOffset,
				sourceOffset + 4,
			);
		}
	}
	return PNG.sync.write(target).toString("base64");
}
