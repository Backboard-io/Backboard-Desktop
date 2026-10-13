import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import {
	imageSize,
	MODEL_IMAGE_MAX_EDGE,
} from "../src/core/image/fitImageForModel.ts";
import { loadAttachments } from "../src/providers/byok/attachments.ts";

describe("loadAttachments", () => {
	it("downscales large image attachments", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cli-attach-"));
		const png = new PNG({ width: 3024, height: 1964 });
		png.data.fill(120);
		await writeFile(join(dir, "Pasted Image.png"), PNG.sync.write(png));

		const [attachment] = await loadAttachments([join(dir, "Pasted Image.png")]);
		const size = imageSize(
			Buffer.from(attachment?.base64 ?? "", "base64"),
			attachment?.mediaType ?? "",
		);

		expect(Math.max(size?.width ?? 0, size?.height ?? 0)).toBe(
			MODEL_IMAGE_MAX_EDGE,
		);
	});

	it("points at attached PDFs instead of inlining their bytes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cli-attach-"));
		const pdfPath = join(dir, "deck.pdf");
		await writeFile(
			pdfPath,
			Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4096, 7)]),
		);

		const [attachment] = await loadAttachments([pdfPath]);

		expect(attachment?.mediaType).toBe("text/plain");
		expect(attachment?.text).toContain(`The attached PDF is at ${pdfPath}`);
		expect(attachment?.text).not.toContain("%PDF");
	});
});
