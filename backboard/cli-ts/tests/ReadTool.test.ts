import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { EventBus } from "../src/core/bus/EventBus.ts";
import {
	imageSize,
	MODEL_IMAGE_MAX_EDGE,
} from "../src/core/image/fitImageForModel.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { READ_TOOL_MAX_BYTES } from "../src/tools/ReadTool.constants.ts";
import { ReadTool } from "../src/tools/ReadTool.tsx";

function context(cwd: string): ToolContext {
	return {
		sessionId: "sess_test",
		cwd,
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => "noop",
		agentDepth: 0,
	};
}

async function tempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "cli-read-"));
}

describe("ReadTool", () => {
	it("reads text files as plain text", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "notes.txt"), "alpha\nbeta\n", "utf8");

		const result = await new ReadTool().execute(
			{ file_path: "notes.txt" },
			context(cwd),
		);

		expect(result.forLLM).toBe("alpha\nbeta\n");
		expect(result.title).toBe("Read 3 lines");
	});

	it("returns supported image files as direct image payloads", async () => {
		const fixturePath = join(import.meta.dir, "fixtures", "read-image.png");
		const imageBytes = await readFile(fixturePath);

		const result = await new ReadTool().execute(
			{ file_path: fixturePath },
			context(await tempDir()),
		);
		const payload = JSON.parse(result.forLLM) as Record<string, unknown>;

		expect(payload.contentType).toBe("image");
		expect(payload.mimeType).toBe("image/png");
		expect(payload.__image_media_type).toBe("image/png");
		expect(payload.__image_base64).toBe(imageBytes.toString("base64"));
		expect(result.title).toContain("Read image");
	});

	it("maps additional supported image extensions to MIME types", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "sample.webp"), Buffer.from("image-bytes"));

		const result = await new ReadTool().execute(
			{ file_path: "sample.webp" },
			context(cwd),
		);
		const payload = JSON.parse(result.forLLM) as Record<string, unknown>;

		expect(payload.mimeType).toBe("image/webp");
		expect(payload.__image_media_type).toBe("image/webp");
	});

	it("rejects oversized image files before encoding", async () => {
		const cwd = await tempDir();
		await writeFile(
			join(cwd, "huge.png"),
			Buffer.alloc(READ_TOOL_MAX_BYTES + 1),
		);

		await expect(
			new ReadTool().execute({ file_path: "huge.png" }, context(cwd)),
		).rejects.toThrow("File too large");
	});
	it("downscales images larger than the model's edge limit", async () => {
		const cwd = await tempDir();
		const png = new PNG({ width: 3000, height: 1500 });
		png.data.fill(200);
		await writeFile(join(cwd, "slide.png"), PNG.sync.write(png));

		const result = await new ReadTool().execute(
			{ file_path: "slide.png" },
			context(cwd),
		);
		const payload = JSON.parse(result.forLLM) as Record<string, unknown>;
		const sent = Buffer.from(String(payload.__image_base64), "base64");
		const size = imageSize(sent, String(payload.__image_media_type));

		expect(payload.resizedFrom).toEqual({ width: 3000, height: 1500 });
		expect(size).toBeDefined();
		expect(Math.max(size?.width ?? 0, size?.height ?? 0)).toBeLessThanOrEqual(
			MODEL_IMAGE_MAX_EDGE,
		);
		expect(payload.imageSize).toEqual(size);
	});

	it("refuses PDFs instead of reading their bytes as text", async () => {
		const cwd = await tempDir();
		await writeFile(
			join(cwd, "deck.pdf"),
			Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 1)]),
		);

		await expect(
			new ReadTool().execute({ file_path: "deck.pdf" }, context(cwd)),
		).rejects.toThrow("deck.pdf is a PDF");
	});

	it("refuses other binary files", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "blob.bin"), Buffer.from([1, 2, 0, 3, 4]));

		await expect(
			new ReadTool().execute({ file_path: "blob.bin" }, context(cwd)),
		).rejects.toThrow("blob.bin is a binary file");
	});
});
