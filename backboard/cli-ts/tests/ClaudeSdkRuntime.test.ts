import { describe, expect, it } from "bun:test";
import { ensureClaudeSdkSharedMemory } from "../src/providers/subscription/ClaudeSdkRuntime.ts";

describe("Claude SDK runtime", () => {
	it("preserves the existing native shared buffer constructor", () => {
		const constructor = SharedArrayBuffer;
		ensureClaudeSdkSharedMemory();
		expect(SharedArrayBuffer).toBe(constructor);
	});

	it("loads the real SDK when the runtime omits the global constructor", async () => {
		// Use a separate process so the simulated runtime cannot affect other tests.
		const helper = new URL("../src/providers/subscription/ClaudeSdkRuntime.ts", import.meta.url).pathname;
		const child = Bun.spawn([process.execPath, "--eval", `
			delete globalThis.SharedArrayBuffer;
			const { ensureClaudeSdkSharedMemory } = await import(${JSON.stringify(helper)});
			ensureClaudeSdkSharedMemory();
			const buffer = new SharedArrayBuffer(4);
			if (Atomics.wait(new Int32Array(buffer), 0, 0, 0) !== "timed-out") throw new Error("Not native shared memory");
			const sdk = await import("@anthropic-ai/claude-agent-sdk");
			if (typeof sdk.query !== "function" || typeof sdk.createSdkMcpServer !== "function") throw new Error("SDK failed to load");
			console.log("ready");
		`], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
		]);
		expect({ code, stdout: stdout.trim(), stderr }).toEqual({ code: 0, stdout: "ready", stderr: "" });
	});
});
