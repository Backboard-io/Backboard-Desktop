import { describe, expect, it } from "bun:test";
import {
	ToolPolicy,
	type ToolPolicySnapshot,
} from "../src/core/tools/ToolPolicy.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { GenerateVideoTool } from "../src/tools/GenerateVideoTool.tsx";

function snapshot(
	overrides: Partial<ToolPolicySnapshot> = {},
): ToolPolicySnapshot {
	return {
		profileTools: [],
		modelTools: [],
		excludedTools: [],
		computerUseEnabled: true,
		browserUseEnabled: true,
		skillDiscoveryEnabled: true,
		videoGenerationEnabled: true,
		...overrides,
	};
}

describe("ToolPolicy skill-discovery gate", () => {
	it("blocks find_skill/find_mcp when discovery is disabled", () => {
		const policy = new ToolPolicy(snapshot({ skillDiscoveryEnabled: false }));
		expect(policy.isRuntimeAllowed("find_skill")).toBe(false);
		expect(policy.isRuntimeAllowed("find_mcp")).toBe(false);
	});

	it("also blocks by display name", () => {
		const policy = new ToolPolicy(snapshot({ skillDiscoveryEnabled: false }));
		expect(policy.isRuntimeAllowed("FindSkill")).toBe(false);
		expect(policy.isRuntimeAllowed("FindMcp")).toBe(false);
	});

	it("excludes the discovery tools from schemas when disabled", () => {
		const policy = new ToolPolicy(snapshot({ skillDiscoveryEnabled: false }));
		const excluded = policy.schemaExcludedNames();
		expect(excluded).toContain("find_skill");
		expect(excluded).toContain("find_mcp");
	});

	it("keeps generate_video runtime-gated but never emits its schema", () => {
		const off = new ToolPolicy(snapshot({ videoGenerationEnabled: false }));
		expect(off.isRuntimeAllowed("generate_video")).toBe(false);
		expect(off.schemaExcludedNames()).toContain("generate_video");

		// Video generation rides Backboard's hosted tool via the
		// `video_generation: "auto"` request fields; the schema stays off the
		// wire even when enabled so the server does not see a duplicate.
		const on = new ToolPolicy(snapshot({ videoGenerationEnabled: true }));
		expect(on.isRuntimeAllowed("GenerateVideo")).toBe(true);
		expect(on.schemaExcludedNames()).toContain("generate_video");
	});

	it("exposes the direct video schema only for enabled, opted-in turns", () => {
		const registry = new ToolRegistry([
			new GenerateVideoTool({
				generate: async () => ({ url: "https://example.test/video.mp4" }),
			}),
		]);
		const enabled = new ToolPolicy(
			snapshot({ profileTools: ["GenerateVideo"] }),
		);
		const disabled = new ToolPolicy(
			snapshot({ videoGenerationEnabled: false }),
		);
		expect(enabled.visibleSchemas(registry)).toEqual([]);
		expect(disabled.visibleSchemas(registry, [], undefined, true)).toEqual([]);
		expect(
			enabled
				.visibleSchemas(registry, [], undefined, true)
				.map((schema) => schema.function.name),
		).toEqual(["generate_video_direct"]);
	});

	it("allows find_skill/find_mcp when discovery is enabled", () => {
		const policy = new ToolPolicy(snapshot({ skillDiscoveryEnabled: true }));
		expect(policy.isRuntimeAllowed("find_skill")).toBe(true);
		expect(policy.isRuntimeAllowed("find_mcp")).toBe(true);
		const excluded = policy.schemaExcludedNames();
		expect(excluded).not.toContain("find_skill");
		expect(excluded).not.toContain("find_mcp");
	});
});
