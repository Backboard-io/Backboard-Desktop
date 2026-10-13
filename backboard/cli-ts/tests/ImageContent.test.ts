import { describe, expect, it } from "bun:test";
import { PNG } from "pngjs";
import { ImageContent } from "../src/core/image/ImageContent.ts";

function png(width: number, height: number): Buffer {
	const image = new PNG({ width, height });
	for (let offset = 0; offset < image.data.length; offset += 4) {
		image.data.set([23, 120, 240, 128], offset);
	}
	return PNG.sync.write(image);
}

describe("ImageContent minimum vision dimensions", () => {
	for (const [width, height] of [
		[1, 1],
		[1, 12],
		[10, 2],
		[7, 8],
		[8, 8],
	]) {
		it(`enlarges ${width}x${height} PNGs while preserving pixels and aspect ratio`, () => {
			const bytes = png(width!, height!);
			const payload = ImageContent.fromBytes(bytes, "image/png");
			const result = PNG.sync.read(
				Buffer.from(payload.__image_base64, "base64"),
			);
			expect(result.width).toBeGreaterThanOrEqual(8);
			expect(result.height).toBeGreaterThanOrEqual(8);
			expect(result.width * result.height).toBeGreaterThanOrEqual(512);
			expect(result.width / result.height).toBe(width! / height!);
			for (let offset = 0; offset < result.data.length; offset += 4) {
				expect([...result.data.subarray(offset, offset + 4)]).toEqual([
					23, 120, 240, 128,
				]);
			}
			expect(PNG.sync.read(bytes).width).toBe(width!);
		});
	}

	it("leaves images meeting the minimum byte-for-byte unchanged", () => {
		const bytes = png(8, 64);
		expect(ImageContent.fromBytes(bytes, "image/png").__image_base64).toBe(
			bytes.toString("base64"),
		);
	});

	it("uses the same normalization for base64 screenshot payloads", () => {
		const payload = ImageContent.fromBase64(
			png(1, 1).toString("base64"),
			"image/png",
		);
		const result = PNG.sync.read(Buffer.from(payload.__image_base64, "base64"));
		expect([result.width, result.height]).toEqual([23, 23]);
	});
});
