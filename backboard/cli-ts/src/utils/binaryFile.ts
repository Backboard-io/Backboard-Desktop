import { extname } from "node:path";

/**
 * Whether file bytes are a PDF or other binary data. Read as text, such bytes
 * are useless to a model and can be large enough to break the conversation.
 */
export function binaryFileKind(
	filePath: string,
	bytes: Uint8Array,
): "pdf" | "binary" | null {
	if (
		extname(filePath).toLowerCase() === ".pdf" ||
		Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-"
	) {
		return "pdf";
	}
	return bytes.subarray(0, 8000).includes(0) ? "binary" : null;
}

/** What a model should do instead of reading a PDF as text. */
export const PDF_INSPECTION_HINT =
	"To see its pages, render them to PNG (for example `pdftoppm -png -r 80 <file> <prefix>`, or on macOS `sips -s format png <file> --out page1.png` for the first page) and Read the images. To read its text, use `pdftotext <file> -` or a PDF library.";
