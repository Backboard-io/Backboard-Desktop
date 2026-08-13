/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "bun:test";
import {
	parseSkillsBenchSampleArgs,
	summarizeBatchResults,
} from "../scripts/skillsbench-sample.ts";

describe("SkillsBench sample runner", () => {
	it("parses a resumable Grok sample run", () => {
		const options = parseSkillsBenchSampleArgs(
			[
				"--model",
				"xai/grok-4.5",
				"--jobs-dir",
				"results/grok",
				"--heartbeat-seconds",
				"45",
			],
			"/workspace",
		);
		expect(options.model).toBe("xai/grok-4.5");
		expect(options.jobsDir).toBe("/workspace/results/grok");
		expect(options.heartbeatSeconds).toBe(45);
		expect(options.resume).toBe(true);
	});

	it("rejects invalid model and heartbeat values", () => {
		expect(() =>
			parseSkillsBenchSampleArgs(["--model", "grok-4.5"], "/workspace"),
		).toThrow("provider/model");
		expect(() =>
			parseSkillsBenchSampleArgs(["--heartbeat-seconds", "0"], "/workspace"),
		).toThrow("positive integer");
	});

	it("aggregates rewards, usage, costs, and errors", () => {
		const base = {
			agentDurationMs: 1,
			category: "software-engineering",
			costUsd: 1.5,
			difficulty: "medium" as const,
			exitCode: 0,
			inputTokens: 100,
			outputTokens: 10,
			passed: true,
			reward: 1,
			skillInvocations: 2,
			status: "completed" as const,
			totalTokens: 110,
			toolCalls: 3,
			verifierDurationMs: 2,
		};
		const aggregate = summarizeBatchResults(
			[
				{ ...base, id: "task-a" },
				{
					...base,
					costUsd: 0.5,
					exitCode: 1,
					id: "task-b",
					inputTokens: 20,
					outputTokens: 5,
					passed: false,
					reward: null,
					skillInvocations: 0,
					status: "error",
					totalTokens: 25,
					toolCalls: 1,
				},
			],
			20,
		);

		expect(aggregate).toEqual({
			completedTasks: 1,
			costUsd: 2,
			errors: 1,
			inputTokens: 120,
			meanReward: 1,
			outputTokens: 15,
			passedTasks: 1,
			skillInvocations: 2,
			totalTasks: 20,
			totalTokens: 135,
			toolCalls: 4,
		});
	});
});
