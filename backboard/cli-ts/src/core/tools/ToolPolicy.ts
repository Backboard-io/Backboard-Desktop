import type { PromptProfileId } from "../../prompts/profiles/ids.ts";
import { canonicalToolName } from "./names.ts";
import type { OpenAITool } from "./schema.ts";
import type { Tool } from "./Tool.ts";
import type { ToolRegistry } from "./ToolRegistry.ts";
import {
	combineToolAllowlists,
	combineToolExclusions,
	isAllowedByToolList,
} from "./toolLists.ts";

export interface ToolPolicySnapshot {
	profileTools: readonly string[];
	modelTools: readonly string[];
	excludedTools: readonly string[];
	modelExcludedTools?: readonly string[];
	computerUseEnabled: boolean;
	browserUseEnabled: boolean;
	skillDiscoveryEnabled: boolean;
	videoGenerationEnabled: boolean;
}

const SKILL_DISCOVERY_TOOLS = ["find_skill", "find_mcp"];

export class ToolPolicy {
	private readonly allowedTools: string[];
	private readonly excludedToolNames: string[];

	constructor(private readonly snapshot: ToolPolicySnapshot) {
		this.allowedTools = combineToolAllowlists(
			snapshot.profileTools,
			snapshot.modelTools,
		);
		this.excludedToolNames = combineToolExclusions(
			snapshot.excludedTools,
			snapshot.modelExcludedTools ?? [],
		);
	}

	enabledNames(): string[] {
		if (this.allowedTools.length === 0) return [];
		return this.allowedTools.filter(
			(name) => !this.excludedToolNames.includes(name),
		);
	}

	excludedNames(): string[] {
		return [...this.excludedToolNames];
	}

	schemaExcludedNames(): string[] {
		const excluded = new Set(this.excludedToolNames);
		if (!this.snapshot.computerUseEnabled) excluded.add("computer");
		if (!this.snapshot.browserUseEnabled) excluded.add("browser");
		// `generate_video` is Backboard's hosted tool, activated by the
		// `video_generation: "auto"` request fields. Declaring it as a client
		// function makes the server run the hosted one — it must never be
		// emitted as a schema even when video generation is enabled.
		excluded.add("generate_video");
		if (!this.snapshot.skillDiscoveryEnabled) {
			for (const name of SKILL_DISCOVERY_TOOLS) excluded.add(name);
		}
		return [...excluded];
	}

	isRuntimeAllowed(name: string): boolean {
		const canonicalName = canonicalToolName(name);
		if (canonicalName === "computer" && !this.snapshot.computerUseEnabled) {
			return false;
		}
		if (canonicalName === "browser" && !this.snapshot.browserUseEnabled) {
			return false;
		}
		if (
			canonicalName === "generate_video" &&
			!this.snapshot.videoGenerationEnabled
		) {
			return false;
		}
		if (
			SKILL_DISCOVERY_TOOLS.includes(canonicalName) &&
			!this.snapshot.skillDiscoveryEnabled
		) {
			return false;
		}
		if (this.excludedToolNames.includes(canonicalName)) return false;
		return (
			isAllowedByToolList(canonicalName, this.snapshot.profileTools) &&
			isAllowedByToolList(canonicalName, this.snapshot.modelTools)
		);
	}

	visibleTools(
		registry: ToolRegistry,
		extraExcluded: readonly string[] = [],
	): Tool[] {
		const extra = new Set(extraExcluded.map(canonicalToolName));
		return registry
			.list()
			.filter(
				(tool) =>
					this.isRuntimeAllowed(tool.agentName) && !extra.has(tool.agentName),
			);
	}

	visibleSchemas(
		registry: ToolRegistry,
		extraExcluded: readonly string[] = [],
		profile?: PromptProfileId,
	): OpenAITool[] {
		const schemaExcluded = new Set(
			this.schemaExcludedNames().map(canonicalToolName),
		);
		return registry.toJSONSchemasFor(
			this.visibleTools(registry, extraExcluded).filter(
				(tool) => !schemaExcluded.has(canonicalToolName(tool.agentName)),
			),
			profile,
		);
	}
}
