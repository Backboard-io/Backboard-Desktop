import { describe, expect, it } from "bun:test";
import {
	ToolPolicy,
	type ToolPolicySnapshot,
} from "../src/core/tools/ToolPolicy.ts";

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

	it("hides generate_video until a composer video model is selected", () => {
		const off = new ToolPolicy(snapshot({ videoGenerationEnabled: false }));
		expect(off.isRuntimeAllowed("generate_video")).toBe(false);
		expect(off.schemaExcludedNames()).toContain("generate_video");

		const on = new ToolPolicy(snapshot({ videoGenerationEnabled: true }));
		expect(on.isRuntimeAllowed("GenerateVideo")).toBe(true);
		expect(on.schemaExcludedNames()).not.toContain("generate_video");
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
