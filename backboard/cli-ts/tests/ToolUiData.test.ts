import { describe, expect, it } from "bun:test";
import {
	backboardToolUiInput,
	backboardToolUiResult,
} from "../src/core/tools/ToolUiData.ts";

describe("ToolUiData", () => {
	it("emits bounded read previews with a uniform truncation marker", () => {
		const content = Array.from(
			{ length: 100 },
			(_, index) => `line ${index}`,
		).join("\n");
		const ui = backboardToolUiResult(
			"read",
			{ file_path: "/workspace/file.ts", offset: 0, limit: 100 },
			{
				filePath: "/workspace/file.ts",
				content,
				totalLines: 100,
				truncated: false,
			},
		);

		expect(ui?.kind).toBe("read");
		expect(ui?.result?.uiTruncated).toBe(true);
		expect((ui?.result?.content as string).split("\n")).toHaveLength(80);
	});

	it("does not copy image bytes into read metadata", () => {
		const ui = backboardToolUiResult(
			"read",
			{ file_path: "/workspace/image.png" },
			{
				filePath: "/workspace/image.png",
				contentType: "image",
				mimeType: "image/png",
				sizeBytes: 123,
				__image_base64: "secret-image-bytes",
				__image_media_type: "image/png",
			},
		);

		expect(JSON.stringify(ui)).not.toContain("secret-image-bytes");
		expect(ui?.result).toEqual({
			filePath: "/workspace/image.png",
			contentType: "image",
			mimeType: "image/png",
			sizeBytes: 123,
		});
	});

	it("caps action inputs while redacting typed text", () => {
		const input = backboardToolUiInput("computer", {
			actions: Array.from({ length: 21 }, () => ({
				action: "type",
				text: "super-secret",
			})),
		});

		expect(input?.input).toEqual({
			actions: Array.from({ length: 20 }, () => ({
				action: "type",
				textLength: 12,
			})),
			uiTruncated: true,
		});
		expect(JSON.stringify(input)).not.toContain("super-secret");
	});

	it("strips screenshot payloads", () => {
		const result = backboardToolUiResult(
			"computer",
			{},
			{
				success: true,
				results: [
					{
						success: true,
						action: "screenshot",
						screenshotPath: "/tmp/shot.png",
						elements: [{ id: "button", label: "Private" }],
						__image_base64: "secret-image-bytes",
						__image_media_type: "image/png",
					},
				],
			},
		);

		expect(JSON.stringify(result)).not.toContain("secret-image-bytes");
		expect(JSON.stringify(result)).not.toContain("Private");
		expect(result?.result?.results).toEqual([
			{
				success: true,
				action: "screenshot",
				screenshotPath: "/tmp/shot.png",
				elementCount: 1,
				imageMediaType: "image/png",
			},
		]);
	});

	it("propagates nested computer observation truncation", () => {
		const result = backboardToolUiResult(
			"computer",
			{},
			{
				success: true,
				results: [
					{
						success: true,
						action: "click",
						verification: "passed",
						observation: {
							observationId: "observation-1",
							screenshotPath: "/tmp/nested.png",
							elements: [{ id: "button", label: "Private nested label" }],
							summary: "x".repeat(1_001),
							__image_base64: "nested-secret-image-bytes",
							__image_media_type: "image/png",
						},
					},
				],
			},
		);

		expect(JSON.stringify(result)).not.toContain("nested-secret-image-bytes");
		expect(JSON.stringify(result)).not.toContain("Private nested label");
		expect(result?.result).toEqual({
			success: true,
			results: [
				{
					success: true,
					action: "click",
					verification: "passed",
					observation: {
						success: true,
						action: "screenshot",
						observationId: "observation-1",
						screenshotPath: "/tmp/nested.png",
						elementCount: 1,
						summary: "x".repeat(1_000),
						imageMediaType: "image/png",
					},
				},
			],
			uiTruncated: true,
		});
	});

	it("marks capped glob results and excludes existing specialized paths", () => {
		const glob = backboardToolUiResult(
			"glob",
			{ patterns: ["**/*"] },
			{
				files: Array.from({ length: 101 }, (_, index) => `file-${index}`),
				count: 101,
			},
		);

		expect(glob?.result?.uiTruncated).toBe(true);
		expect(glob?.result?.files).toHaveLength(100);
		for (const name of [
			"execute",
			"agent",
			"ask_user",
			"write",
			"edit",
			"apply_patch",
		]) {
			expect(backboardToolUiInput(name, {})).toBeUndefined();
		}
	});
});
