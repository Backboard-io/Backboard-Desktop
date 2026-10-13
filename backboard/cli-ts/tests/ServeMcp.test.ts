import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SERVE_CAPABILITIES } from "../src/entrypoints/ServeTypes.ts";
import {
	DEFAULT_MCP_TURN_WAIT_MS,
	McpStatusPublisher,
	McpWorkQueue,
	mcpTurnWaitMs,
	resolveMcpServerSet,
	type ServeMcpPayload,
	type ServeRuntimeMcpServer,
	waitForMcpWork,
} from "../src/entrypoints/serveMcp.ts";

async function configFixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "serve-mcp-"));
	await mkdir(path.join(root, ".git"));
	const project = path.join(root, ".backboard", "mcp.json");
	const user = path.join(root, "home", ".backboard", "mcp.json");
	await writeJsonFile(project, {
		mcpServers: {
			projectOnly: { command: "node", args: ["p.js"], disabledTools: ["x"] },
			shared: { command: "node", args: ["project-shared.js"] },
			projectOff: { command: "node", disabled: true },
		},
	});
	await writeJsonFile(user, {
		mcpServers: {
			// The user disabled/uninstalled these in the IDE, which stopped
			// pushing them; an authoritative push must not resurrect them.
			userOnly: { type: "streamable-http", url: "https://user.example/mcp" },
			shared: { command: "node", args: ["user-shared.js"] },
		},
	});
	return { root, paths: { project, user } };
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(value));
}

describe("resolveMcpServerSet", () => {
	it("layers only project and runtime servers under an authoritative push", async () => {
		const { root, paths } = await configFixture();
		const runtime = new Map<string, ServeRuntimeMcpServer>([
			[
				"found",
				{
					entry: { command: "npx", args: ["found"] },
					configSources: [{ scope: "user", path: paths.user }],
				},
			],
			[
				"adopted",
				{ entry: { command: "npx", args: ["old"] }, configSources: [] },
			],
		]);
		const { entries, sources } = await resolveMcpServerSet({
			cwd: root,
			paths,
			authoritative: true,
			runtime,
			pushed: {
				ide: { type: "streamable-http", url: "https://ide.example/mcp" },
				adopted: { command: "npx", args: ["new"] },
			},
		});

		expect(Object.keys(entries).sort()).toEqual([
			"adopted",
			"found",
			"ide",
			"projectOff",
			"projectOnly",
			"shared",
		]);
		expect(entries.shared).toMatchObject({ args: ["project-shared.js"] });
		expect(entries.projectOnly).toMatchObject({ disabledTools: ["x"] });
		expect(entries.projectOff).toMatchObject({ disabled: true });
		expect(entries.adopted).toEqual({ command: "npx", args: ["new"] });
		expect(
			Object.fromEntries(
				Object.entries(sources).map(([name, source]) => [name, source.origin]),
			),
		).toEqual({
			projectOnly: "project",
			shared: "project",
			projectOff: "project",
			found: "runtime",
			adopted: "ide",
			ide: "ide",
		});
		expect(sources.ide?.configSources).toEqual([]);
		expect(sources.projectOnly?.configSources).toEqual([
			{ scope: "project", path: paths.project },
		]);
	});

	it("layers both files without authoritative (standalone behavior)", async () => {
		const { root, paths } = await configFixture();
		const { entries, sources } = await resolveMcpServerSet({
			cwd: root,
			paths,
			authoritative: false,
			runtime: new Map(),
			pushed: { ide: { command: "ide" } },
		});
		expect(Object.keys(entries).sort()).toEqual([
			"ide",
			"projectOff",
			"projectOnly",
			"shared",
			"userOnly",
		]);
		// The user file wins field-by-field, as in `loadMcpConfig`.
		expect(entries.shared).toMatchObject({ args: ["user-shared.js"] });
		expect(sources.userOnly).toEqual({
			origin: "user",
			configSources: [{ scope: "user", path: paths.user }],
		});
		expect(sources.shared?.configSources).toEqual([
			{ scope: "project", path: paths.project },
			{ scope: "user", path: paths.user },
		]);
	});
});

describe("McpWorkQueue", () => {
	it("serializes work and lets turns wait for the latest blocking operation", async () => {
		const queue = new McpWorkQueue();
		const order: string[] = [];
		let releaseInit: () => void = () => undefined;
		const init = queue.run(
			async () => {
				order.push("init:start");
				await new Promise<void>((resolve) => {
					releaseInit = resolve;
				});
				order.push("init:end");
			},
			{ blocksTurns: true },
		);
		const push = queue.run(
			async () => {
				order.push("push");
				throw new Error("push failed");
			},
			{ blocksTurns: true },
		);
		const barrier = queue.turnBarrier;
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(order).toEqual(["init:start"]);
		expect(await waitForMcpWork(barrier, 5)).toBe("timeout");

		releaseInit();
		await init;
		await expect(push).rejects.toThrow("push failed");
		// A failed push still releases the turn and the queue.
		expect(await waitForMcpWork(barrier, 1_000)).toBe("settled");
		expect(order).toEqual(["init:start", "init:end", "push"]);
		expect(await queue.run(async () => "next")).toBe("next");
	});

	it("does not make turns wait for non-blocking work", async () => {
		const queue = new McpWorkQueue();
		expect(await waitForMcpWork(queue.turnBarrier, 1_000)).toBe("settled");
		void queue.run(() => new Promise<void>(() => undefined));
		expect(queue.turnBarrier).toBeUndefined();
	});

	it("stops waiting when the turn is cancelled", async () => {
		const controller = new AbortController();
		const pending = waitForMcpWork(
			new Promise(() => undefined),
			60_000,
			controller.signal,
		);
		controller.abort();
		expect(await pending).toBe("aborted");
	});
});

describe("mcpTurnWaitMs", () => {
	it("defaults to 15s and honors a non-negative integer override", () => {
		expect(DEFAULT_MCP_TURN_WAIT_MS).toBe(15_000);
		expect(mcpTurnWaitMs(undefined)).toBe(15_000);
		expect(mcpTurnWaitMs("2500")).toBe(2_500);
		expect(mcpTurnWaitMs("0")).toBe(0);
		expect(mcpTurnWaitMs("-1")).toBe(15_000);
		expect(mcpTurnWaitMs("soon")).toBe(15_000);
	});
});

describe("McpStatusPublisher", () => {
	it("coalesces bursts into one full snapshot with accumulated warnings", async () => {
		const written: ServeMcpPayload[] = [];
		let state = "connecting";
		const publisher = new McpStatusPublisher(
			(payload) => written.push(payload),
			() => [
				{
					name: "a",
					type: "stdio",
					configSources: [],
					status: state as "connecting",
					toolNames: [],
					source: "ide",
				},
			],
			5,
		);
		publisher.schedule();
		publisher.schedule(["slow server"]);
		state = "connected";
		publisher.schedule();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(written).toEqual([
			{
				servers: [
					{
						name: "a",
						type: "stdio",
						configSources: [],
						status: "connected",
						toolNames: [],
						source: "ide",
					},
				],
				warnings: ["slow server"],
			},
		]);
		publisher.dispose();
		publisher.schedule();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(written).toHaveLength(1);
	});

	it("is advertised to the IDE", () => {
		expect(SERVE_CAPABILITIES).toContain("mcp-status-events");
	});
});
