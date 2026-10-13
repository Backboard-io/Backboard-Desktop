import { basename, extname } from "node:path";
import { fitImageForModel } from "../../core/image/fitImageForModel.ts";
import { binaryFileKind, PDF_INSPECTION_HINT } from "../../utils/binaryFile.ts";
import { errorMessage } from "../../utils/errors.ts";
import type { ByokAttachment } from "./ByokTypes.ts";

const IMAGE_MEDIA_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

/** Text attachments above this are truncated rather than blowing the context. */
const MAX_INLINE_TEXT_BYTES = 64 * 1024;

/**
 * Backboard uploads attachments as multipart and resolves them server-side.
 * Vendor APIs have no such endpoint, so files are inlined into the message:
 * images as base64 parts, anything else as truncated text.
 */
export async function loadAttachments(
	filePaths: readonly string[],
): Promise<ByokAttachment[]> {
	const attachments: ByokAttachment[] = [];
	for (const path of filePaths) {
		const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()];
		try {
			const file = Bun.file(path);
			const buffer = Buffer.from(await file.arrayBuffer());
			if (mediaType) {
				// Fit images to the provider's limits: an image it rejects stays in
				// the conversation and fails every later turn too.
				try {
					const image = await fitImageForModel({
						path,
						bytes: buffer,
						mimeType: mediaType,
						signal: new AbortController().signal,
					});
					attachments.push({
						path: basename(path),
						mediaType: image.mimeType,
						base64: image.bytes.toString("base64"),
					});
				} catch (error) {
					attachments.push({
						path: basename(path),
						mediaType: "text/plain",
						text: `The attached image ${path} could not be included (${errorMessage(error)}).`,
					});
				}
				continue;
			}
			const kind = binaryFileKind(path, buffer);
			if (kind) {
				attachments.push({
					path: basename(path),
					mediaType: "text/plain",
					text:
						kind === "pdf"
							? `The attached PDF is at ${path}; it is not inlined. ${PDF_INSPECTION_HINT}`
							: `The attached binary file is at ${path} (${buffer.byteLength} bytes); it is not inlined. Inspect it with a tool made for its format.`,
				});
				continue;
			}
			const text = buffer.toString("utf8");
			attachments.push({
				path: basename(path),
				mediaType: "text/plain",
				text:
					text.length > MAX_INLINE_TEXT_BYTES
						? `${text.slice(0, MAX_INLINE_TEXT_BYTES)}\n… (truncated)`
						: text,
			});
		} catch {
			// An unreadable attachment must not fail the turn - the model simply
			// does not see it.
		}
	}
	return attachments;
}
