import { describe, expect, it } from "bun:test";
import { runWorkerReplayTrial } from "../scripts/parallel-worker-benchmark.ts";

describe("offline worker batch replay", () => {
	for (const workspaceKind of ["non-git", "dirty-git"] as const) {
		it(`integrates three batch writers and preserves a parent edit through undo in ${workspaceKind}`, async () => {
			const result = await runWorkerReplayTrial({
				launchMode: "batch",
				workspaceKind,
				modelDelayMs: 0,
				parentEdit: true,
			});
			expect(result.integratedWorkers).toBe(3);
			expect(result.providerRequests).toBe(6);
			expect(result.maxActiveProviderRequests).toBe(3);
			expect(result.peakWorkerLifetimes).toBe(3);
			expect(result.parentEditVerified).toBe(true);
			expect(result.undoVerified).toBe(true);
			expect(result.undoCount).toBe(3);
		}, 30_000);
	}

	it("keeps sequential registration equivalent to a batch without extra child inference", async () => {
		const result = await runWorkerReplayTrial({
			launchMode: "sequential-registration",
			workspaceKind: "non-git",
			modelDelayMs: 0,
			parentEdit: true,
		});
		expect(result.integratedWorkers).toBe(3);
		expect(result.providerRequests).toBe(6);
		expect(result.maxActiveProviderRequests).toBe(3);
		expect(result.parentEditVerified).toBe(true);
		expect(result.undoCount).toBe(3);
	}, 30_000);
});
