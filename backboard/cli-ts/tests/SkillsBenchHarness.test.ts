/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "bun:test";
import {
	bunTargetForDockerArchitecture,
	parseSkillsBenchArgs,
	parseTaskDefinition,
	skillsBenchCheckoutDir,
	summarizeAgentTrace,
} from "../scripts/skillsbench-eval.ts";

describe("SkillsBench harness", () => {
	it("parses a reproducible Backboard run", () => {
		const options = parseSkillsBenchArgs(
			[
				"--model",
				"openai/gpt-5.5",
				"--task",
				"citation-check",
				"--ref",
				"v1.1",
				"--condition",
				"both",
			],
			"/workspace",
		);

		expect({
			cacheDir: options.cacheDir,
			condition: options.condition,
			model: options.model,
			ref: options.ref,
			taskId: options.taskId,
		}).toEqual({
			cacheDir: "/workspace/benchmark-cache/skillsbench",
			condition: "both",
			model: "openai/gpt-5.5",
			ref: "v1.1",
			taskId: "citation-check",
		});
	});

	it("allows preparation without a model", () => {
		const options = parseSkillsBenchArgs(
			["--prepare-only", "--task", "citation-check"],
			"/workspace",
		);
		expect(options.prepareOnly).toBe(true);
		expect(options.model).toBeUndefined();
	});

	it("isolates task checkouts for parallel evaluators", () => {
		expect(
			skillsBenchCheckoutDir(
				"/workspace/benchmark-cache/skillsbench",
				"v1.1",
				"citation-check",
			),
		).toBe(
			"/workspace/benchmark-cache/skillsbench/checkouts/v1.1/citation-check",
		);
	});

	it("rejects path traversal in task ids and refs", () => {
		expect(() =>
			parseSkillsBenchArgs(
				["--model", "openai/gpt-5.5", "--task", "../private"],
				"/workspace",
			),
		).toThrow("lowercase SkillsBench task id");
		expect(() =>
			parseSkillsBenchArgs(
				["--model", "openai/gpt-5.5", "--ref", "main..secret"],
				"/workspace",
			),
		).toThrow("simple branch, tag, or commit name");
	});

	it("reads time and resource limits from task frontmatter", () => {
		const task = parseTaskDefinition(`---
agent:
  timeout_sec: 12
verifier:
  timeout_sec: 7
environment:
  cpus: 2
  memory_mb: 4096
---
Create /root/result.json.
`);
		expect(task).toEqual({
			agentTimeoutMs: 12_000,
			cpus: 2,
			memoryMb: 4096,
			prompt: "Create /root/result.json.",
			verifierTimeoutMs: 7_000,
		});
	});

	it("maps Docker architectures to Linux Bun targets", () => {
		expect([
			bunTargetForDockerArchitecture("amd64"),
			bunTargetForDockerArchitecture("aarch64"),
		]).toEqual(["bun-linux-x64", "bun-linux-arm64"]);
	});

	it("summarizes tool, skill, token, and cost events", () => {
		const trace = [
			JSON.stringify({
				type: "tool:requested",
				payload: {
					calls: [{ name: "FindSkill" }, { name: "Execute" }],
				},
			}),
			JSON.stringify({
				type: "usage",
				payload: {
					usage: {
						costUsd: 0.12,
						inputTokens: 20,
						model: "gpt-5.5",
						outputTokens: 10,
						totalTokens: 30,
					},
				},
			}),
			"not-json",
		].join("\n");

		expect(summarizeAgentTrace(trace)).toEqual({
			costUsd: 0.12,
			inputTokens: 20,
			invalidLines: 1,
			models: ["gpt-5.5"],
			outputTokens: 10,
			skillInvocations: 1,
			toolCalls: 2,
			totalTokens: 30,
		});
	});
});
