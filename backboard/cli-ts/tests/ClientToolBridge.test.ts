import { describe, expect, it } from "bun:test";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { AgentEvent } from "../src/core/bus/events.ts";
import {
	type ClientProxyTool,
	ClientToolBridge,
} from "../src/core/tools/ClientToolBridge.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { makeContext } from "./helpers.ts";

const OPEN_PAGE = {
	name: "open_browser_page",
	description: "Open a page in the integrated browser",
	inputSchema: {
		type: "object",
		properties: { url: { type: "string" } },
	} as Record<string, unknown>,
};

describe("ClientToolBridge", () => {
	it("registers, replaces, and clears client tools without touching local tools", () => {
		const bus = new EventBus();
		const registry = new ToolRegistry();
		const bridge = new ClientToolBridge(bus, registry);

		bridge.setTools([OPEN_PAGE, { name: "read_page" }]);
		expect(registry.has("open_browser_page")).toBe(true);
		expect(registry.has("read_page")).toBe(true);

		bridge.setTools([{ name: "read_page" }]);
		expect(registry.has("open_browser_page")).toBe(false);
		expect(registry.has("read_page")).toBe(true);

		bridge.setTools([]);
		expect(registry.has("read_page")).toBe(false);
	});

	it("skips names that collide with local tools and warns", () => {
		const bus = new EventBus();
		const warnings: string[] = [];
		bus.on("system:warning", (event) => warnings.push(event.message));
		const registry = new ToolRegistry();
		const bridge = new ClientToolBridge(bus, registry);
		bridge.setTools([{ name: "open_browser_page" }]);
		const local = registry.get("open_browser_page");

		// A second bridge (stale client) must not displace the registered tool.
		const other = new ClientToolBridge(bus, registry);
		other.setTools([{ name: "open_browser_page" }]);
		expect(registry.get("open_browser_page")).toBe(local);
		expect(
			warnings.some((message) => message.includes("open_browser_page")),
		).toBe(true);
	});

	it("advertises the IDE schema verbatim and parks execution until the result op", async () => {
		const bus = new EventBus();
		const events: AgentEvent[] = [];
		bus.onAny((event) => events.push(event));
		const registry = new ToolRegistry();
		const bridge = new ClientToolBridge(bus, registry);
		bridge.setTools([OPEN_PAGE]);

		const tool = registry.get("open_browser_page") as ClientProxyTool;
		expect(tool.toJSONSchema()).toEqual({
			type: "function",
			function: {
				name: "open_browser_page",
				description: "Open a page in the integrated browser",
				parameters: OPEN_PAGE.inputSchema,
			},
		});

		const ctx = {
			...makeContext(new AbortController().signal, bus),
			toolCallId: "call_1",
		};
		const pending = tool.execute({ url: "http://localhost:8765" }, ctx);
		const callEvent = events.find(
			(event) => event.type === "client_tool:call",
		) as Extract<AgentEvent, { type: "client_tool:call" }>;
		expect(callEvent).toMatchObject({
			toolCallId: "call_1",
			name: "open_browser_page",
			input: { url: "http://localhost:8765" },
		});

		bridge.provideResult("call_1", {
			success: true,
			content: [
				{ type: "text", text: "Opened. Page ID: page_9" },
				{ type: "image", mimeType: "image/jpeg", dataBase64: "aGk=" },
			],
		});
		const result = await pending;
		expect(result.data).toMatchObject({
			success: true,
			output: "Opened. Page ID: page_9",
			__image_base64: "aGk=",
			__image_media_type: "image/jpeg",
		});
	});

	it("turns an IDE error payload into a thrown tool error", async () => {
		const bus = new EventBus();
		const registry = new ToolRegistry();
		const bridge = new ClientToolBridge(bus, registry);
		bridge.setTools([OPEN_PAGE]);
		const tool = registry.get("open_browser_page") as ClientProxyTool;
		const ctx = {
			...makeContext(new AbortController().signal, bus),
			toolCallId: "call_2",
		};
		const pending = tool.execute({}, ctx);
		bridge.provideResult("call_2", {
			error: "The user declined this tool call.",
		});
		await expect(pending).rejects.toThrow("The user declined this tool call.");
	});

	it("rejects parked calls on abort", async () => {
		const bus = new EventBus();
		const registry = new ToolRegistry();
		const bridge = new ClientToolBridge(bus, registry);
		bridge.setTools([OPEN_PAGE]);
		const tool = registry.get("open_browser_page") as ClientProxyTool;
		const controller = new AbortController();
		const ctx = {
			...makeContext(controller.signal, bus),
			toolCallId: "call_3",
		};
		const pending = tool.execute({}, ctx);
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
		// A late result for the aborted call is ignored.
		bridge.provideResult("call_3", { success: true });
	});

	it("defers permissions to the IDE outside manual mode", () => {
		const bus = new EventBus();
		const registry = new ToolRegistry();
		const bridge = new ClientToolBridge(bus, registry);
		bridge.setTools([OPEN_PAGE]);
		const tool = registry.get("open_browser_page") as ClientProxyTool;
		expect(
			tool.checkPermissions({}, { mode: "auto", cwd: "/", interactive: true }),
		).toMatchObject({ behavior: "allow" });
		expect(
			tool.checkPermissions(
				{},
				{ mode: "bypass", cwd: "/", interactive: true },
			),
		).toMatchObject({ behavior: "allow" });
		expect(
			tool.checkPermissions(
				{},
				{ mode: "manual", cwd: "/", interactive: true },
			),
		).toBeUndefined();
	});
});
