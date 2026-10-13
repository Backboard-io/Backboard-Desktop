import { basename, extname } from "node:path";

type JsonObject = Record<string, unknown>;

const IMAGE_MEDIA_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

const FILE_MEDIA_TYPES: Record<string, string> = {
	".pdf": "application/pdf",
	".json": "application/json",
	".csv": "text/csv",
	".html": "text/html",
	".md": "text/markdown",
	".txt": "text/plain",
	".xml": "application/xml",
};

/** Keep base64 requests below the Responses API's per-file practical ceiling. */
const MAX_INLINE_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Converts local paths into native Responses input content. Images use
 * `input_image`; other files use `input_file`, so PDFs and structured files do
 * not get corrupted by a UTF-8 text conversion.
 */
export async function loadSubscriptionAttachmentParts(
	filePaths: readonly string[],
): Promise<JsonObject[]> {
	const parts: JsonObject[] = [];
	for (const path of filePaths) {
		const file = Bun.file(path);
		try {
			if (file.size > MAX_INLINE_FILE_BYTES) {
				throw new Error(
					`Attachment ${basename(path)} exceeds the 20 MB inline limit.`,
				);
			}
			const extension = extname(path).toLowerCase();
			const bytes = Buffer.from(await file.arrayBuffer());
			const imageMediaType = IMAGE_MEDIA_TYPES[extension];
			if (imageMediaType) {
				parts.push({
					type: "input_image",
					image_url: `data:${imageMediaType};base64,${bytes.toString("base64")}`,
					detail: "auto",
				});
				continue;
			}
			const mediaType =
				FILE_MEDIA_TYPES[extension] ?? "application/octet-stream";
			parts.push({
				type: "input_file",
				filename: basename(path),
				file_data: `data:${mediaType};base64,${bytes.toString("base64")}`,
			});
		} catch (error) {
			throw new Error(`Could not attach ${path}: ${String(error)}`, {
				cause: error,
			});
		}
	}
	return parts;
}
