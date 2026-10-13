/**
 * Prepares a local image file for a vision model.
 *
 * Providers reject an image that is too large, too big in pixels, or in a
 * format they do not accept, and a rejected image stays in the conversation:
 * every later request re-sends it and fails the same way. Anthropic, for
 * example, takes only PNG/JPEG/GIF/WebP, caps each image at 5 MB of base64,
 * and caps each side at 2000px once a request holds many images. So every
 * image a tool hands the model is converted to an accepted format and fitted
 * to `MODEL_IMAGE_MAX_EDGE` and `MODEL_IMAGE_MAX_BYTES` first.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { run, runWithOutput } from "../platform/process.ts";

/** Anthropic's recommended long edge; larger images are downscaled server-side anyway. */
export const MODEL_IMAGE_MAX_EDGE = 1568;
/** 5 MB once base64-encoded (base64 grows bytes by 4/3). */
export const MODEL_IMAGE_MAX_BYTES = 3_750_000;
/** The long edge tried when an image is still too large at `MODEL_IMAGE_MAX_EDGE`. */
const FALLBACK_EDGE = 1024;

const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

/** Sources that are usually photos convert to JPEG; the rest stay lossless. */
const PHOTO_TYPES: ReadonlySet<string> = new Set([
	"image/jpeg",
	"image/webp",
	"image/heic",
	"image/heif",
	"image/avif",
	"image/tiff",
]);

export interface ImageSize {
	width: number;
	height: number;
}

export interface FittedImage {
	bytes: Buffer;
	mimeType: string;
	/** The size sent to the model, when known. */
	size?: ImageSize;
	/** The source size, set only when the image was resized. */
	resizedFrom?: ImageSize;
	/** The source type, set only when the image was converted. */
	convertedFrom?: string;
}

type OutputFormat = "png" | "jpeg";

export async function fitImageForModel(input: {
	path: string;
	bytes: Buffer;
	mimeType: string;
	signal: AbortSignal;
}): Promise<FittedImage> {
	const { path, bytes, mimeType, signal } = input;
	let size = imageSize(bytes, mimeType);
	if (
		MODEL_IMAGE_TYPES.has(mimeType) &&
		bytes.byteLength <= MODEL_IMAGE_MAX_BYTES &&
		(!size || Math.max(size.width, size.height) <= MODEL_IMAGE_MAX_EDGE)
	) {
		return { bytes, mimeType, ...(size ? { size } : {}) };
	}
	if (!size && process.platform === "darwin") {
		size = await sipsSize(path, signal).catch(() => undefined);
	}

	const first: OutputFormat = PHOTO_TYPES.has(mimeType) ? "jpeg" : "png";
	const attempts: Array<[OutputFormat, number]> = [
		[first, MODEL_IMAGE_MAX_EDGE],
		...(first === "png"
			? ([["jpeg", MODEL_IMAGE_MAX_EDGE]] as Array<[OutputFormat, number]>)
			: []),
		["jpeg", FALLBACK_EDGE],
	];
	const dir = await mkdtemp(join(tmpdir(), "bb-image-"));
	try {
		let lastError: unknown;
		for (const [format, maxEdge] of attempts) {
			let converted: Buffer;
			try {
				converted = await convertImage(
					path,
					bytes,
					mimeType,
					size,
					format,
					maxEdge,
					join(dir, `fitted-${maxEdge}.${format}`),
					signal,
				);
			} catch (error) {
				signal.throwIfAborted();
				lastError = error;
				continue;
			}
			if (converted.byteLength > MODEL_IMAGE_MAX_BYTES) continue;
			const outputType = `image/${format}`;
			const outputSize = imageSize(converted, outputType);
			const resized =
				size && outputSize && outputSize.width !== size.width
					? { resizedFrom: size }
					: {};
			return {
				bytes: converted,
				mimeType: outputType,
				...(outputSize ? { size: outputSize } : {}),
				...resized,
				...(outputType !== mimeType ? { convertedFrom: mimeType } : {}),
			};
		}
		const reason = lastError instanceof Error ? `: ${lastError.message}` : "";
		throw new Error(
			`Could not convert this ${mimeType} image to a PNG or JPEG under ${MODEL_IMAGE_MAX_EDGE}px and ${MODEL_IMAGE_MAX_BYTES} bytes${reason}. Convert or shrink it with another tool, then Read the result.`,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function convertImage(
	path: string,
	bytes: Buffer,
	mimeType: string,
	size: ImageSize | undefined,
	format: OutputFormat,
	maxEdge: number,
	out: string,
	signal: AbortSignal,
): Promise<Buffer> {
	const scale = size
		? Math.min(1, maxEdge / Math.max(size.width, size.height))
		: 1;
	if (process.platform === "darwin") {
		await run(
			"sips",
			[
				"-s",
				"format",
				format,
				...(format === "jpeg" ? ["-s", "formatOptions", "85"] : []),
				// -Z also enlarges, so pass it only when the image must shrink.
				...(scale < 1 || !size ? ["-Z", String(maxEdge)] : []),
				path,
				"--out",
				out,
			],
			signal,
		);
		return await readFile(out);
	}
	if (process.platform === "win32") {
		const script = [
			"Add-Type -AssemblyName System.Drawing;",
			`$src=[System.Drawing.Image]::FromFile(${powershellString(path)});`,
			`$s=[Math]::Min(1.0, ${maxEdge}/[Math]::Max($src.Width,$src.Height));`,
			"$w=[Math]::Max(1,[int]($src.Width*$s));$h=[Math]::Max(1,[int]($src.Height*$s));",
			"$bmp=New-Object System.Drawing.Bitmap $w,$h;",
			"$g=[System.Drawing.Graphics]::FromImage($bmp);",
			"$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;",
			"$g.DrawImage($src,0,0,$w,$h);",
			`$bmp.Save(${powershellString(out)},[System.Drawing.Imaging.ImageFormat]::${format === "png" ? "Png" : "Jpeg"});`,
			"$g.Dispose();$bmp.Dispose();$src.Dispose();",
		].join("");
		await runWithOutput(
			"powershell.exe",
			["-NoProfile", "-Command", script],
			signal,
		);
		return await readFile(out);
	}
	if (mimeType === "image/png" && format === "png") {
		return downscalePng(bytes, maxEdge);
	}
	throw new Error(`no image converter is available on ${process.platform}`);
}

/** Area-average downscale, for platforms without a system image tool. */
function downscalePng(bytes: Buffer, maxEdge: number): Buffer {
	const source = PNG.sync.read(bytes);
	const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
	if (scale === 1) return PNG.sync.write(source);
	const width = Math.max(1, Math.round(source.width * scale));
	const height = Math.max(1, Math.round(source.height * scale));
	const target = new PNG({ width, height });
	for (let y = 0; y < height; y++) {
		const y0 = Math.floor((y * source.height) / height);
		const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * source.height) / height));
		for (let x = 0; x < width; x++) {
			const x0 = Math.floor((x * source.width) / width);
			const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * source.width) / width));
			const count = (y1 - y0) * (x1 - x0);
			const offset = (y * width + x) * 4;
			for (let c = 0; c < 4; c++) {
				let sum = 0;
				for (let sy = y0; sy < y1; sy++) {
					for (let sx = x0; sx < x1; sx++) {
						sum += source.data[(sy * source.width + sx) * 4 + c] ?? 0;
					}
				}
				target.data[offset + c] = Math.round(sum / count);
			}
		}
	}
	return PNG.sync.write(target);
}

async function sipsSize(
	path: string,
	signal: AbortSignal,
): Promise<ImageSize | undefined> {
	const output = await runWithOutput(
		"sips",
		["-g", "pixelWidth", "-g", "pixelHeight", path],
		signal,
	);
	const width = Number(/pixelWidth:\s*(\d+)/.exec(output)?.[1]);
	const height = Number(/pixelHeight:\s*(\d+)/.exec(output)?.[1]);
	return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Reads dimensions from PNG, GIF, JPEG and WebP headers. */
export function imageSize(
	bytes: Buffer,
	mimeType: string,
): ImageSize | undefined {
	try {
		switch (mimeType) {
			case "image/png":
				if (
					bytes.length >= 24 &&
					bytes.readUInt32BE(0) === 0x89504e47 &&
					bytes.toString("ascii", 12, 16) === "IHDR"
				) {
					return sized(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
				}
				return undefined;
			case "image/gif":
				if (bytes.toString("ascii", 0, 4) === "GIF8") {
					return sized(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
				}
				return undefined;
			case "image/jpeg":
				return jpegSize(bytes);
			case "image/webp":
				return webpSize(bytes);
			default:
				return undefined;
		}
	} catch {
		return undefined;
	}
}

function jpegSize(bytes: Buffer): ImageSize | undefined {
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
	let offset = 2;
	while (offset + 9 < bytes.length) {
		if (bytes[offset] !== 0xff) return undefined;
		const marker = bytes[offset + 1] ?? 0;
		if (marker === 0xff) {
			offset++;
			continue;
		}
		const length = bytes.readUInt16BE(offset + 2);
		const isFrame =
			marker >= 0xc0 &&
			marker <= 0xcf &&
			marker !== 0xc4 &&
			marker !== 0xc8 &&
			marker !== 0xcc;
		if (isFrame) {
			return sized(
				bytes.readUInt16BE(offset + 7),
				bytes.readUInt16BE(offset + 5),
			);
		}
		offset += 2 + length;
	}
	return undefined;
}

function webpSize(bytes: Buffer): ImageSize | undefined {
	if (
		bytes.length < 30 ||
		bytes.toString("ascii", 0, 4) !== "RIFF" ||
		bytes.toString("ascii", 8, 12) !== "WEBP"
	) {
		return undefined;
	}
	const chunk = bytes.toString("ascii", 12, 16);
	if (chunk === "VP8 ") {
		return sized(
			bytes.readUInt16LE(26) & 0x3fff,
			bytes.readUInt16LE(28) & 0x3fff,
		);
	}
	if (chunk === "VP8L") {
		const bits = bytes.readUInt32LE(21);
		return sized((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
	}
	if (chunk === "VP8X") {
		return sized(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1);
	}
	return undefined;
}

function sized(width: number, height: number): ImageSize | undefined {
	return width > 0 && height > 0 ? { width, height } : undefined;
}

function powershellString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
