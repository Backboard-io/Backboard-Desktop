import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const read: PromptModule = definePrompt(
	buildReadPrompt(),
	buildReadPrompt,
);

function buildReadPrompt(context: PromptContext = {}): string {
	return `## Read

Reads file contents. For supported image files up to 5 MB, returns the actual image content for direct visual analysis.

### Use When

- You know the exact file path to inspect.${hasTool(context, "Grep") ? "\n- You need a focused slice of a large file after locating relevant lines with Grep." : ""}
- You need to verify surrounding code before editing.
- You need to view or analyze a local image file directly.

${doNotUseWhen(context)}

### Behavior

- Reads the whole file by default.
- Large text files are truncated to preserve context.
- Use offset and limit to read specific portions of huge files.
- For PNG, JPEG/JPG, WebP, GIF, BMP, TIFF/TIF, AVIF, HEIC/HEIF, and ICO files, returns image content instead of text. Large images are downscaled (longest side 1568px) and other formats converted to PNG or JPEG first; the result reports \`imageSize\` and \`resizedFrom\` when that happens.
- Does not read PDFs or other binary files. To check a PDF, render its pages to PNG and Read those, or extract its text with \`pdftotext\`.
- Requires absolute file paths.
`.trim();
}

function doNotUseWhen(context: PromptContext): string {
	const lines = [
		hasTool(context, "Glob")
			? "- You need to discover files by name or extension. Use Glob."
			: "",
		hasTool(context, "Grep")
			? "- You need to search file contents. Use Grep."
			: "",
	].filter(Boolean);
	return lines.length > 0 ? `### Do Not Use When\n\n${lines.join("\n")}` : "";
}
