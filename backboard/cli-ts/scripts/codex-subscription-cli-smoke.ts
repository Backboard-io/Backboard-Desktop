import { randomUUID } from "node:crypto";
import { AgentLoop } from "../src/core/agent/AgentLoop.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { AgentEvent } from "../src/core/bus/events.ts";
import { Session } from "../src/core/session/Session.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import { CodexSubscriptionClient } from "../src/providers/subscription/CodexSubscriptionClient.ts";
import { GlobTool } from "../src/tools/GlobTool.tsx";
import { GrepTool } from "../src/tools/GrepTool.tsx";
import { ReadTool } from "../src/tools/ReadTool.tsx";

function sampleLine(event: AgentEvent): string | null {
	switch (event.type) {
		case "tool:start":
			return `[cli] TOOL START  ${event.name} ${event.inputSummary}`;
		case "tool:result":
			return `[cli] TOOL RESULT ${event.name}: ${event.title}`;
		case "tool:error":
			return `[cli] TOOL ERROR  ${event.name}: ${event.error}`;
		case "assistant:message":
			return `[cli] ASSISTANT   ${event.text}`;
		case "usage":
			return `[cli] USAGE       ${event.usage.inputTokens ?? 0} input / ${event.usage.outputTokens ?? 0} output`;
		case "turn:end":
			return `[cli] TURN END    ${event.status} (${event.durationMs}ms)`;
		default:
			return null;
	}
}

const cwd = process.cwd();
const client = new CodexSubscriptionClient();
const catalog = await client.listModels();
const model = catalog.models[0]?.name;
if (!model) throw new Error("No ChatGPT subscription model is available.");

// These are the production CLI implementations, registry, scheduler, and loop.
// The sample limits exposure to read-only tools so it cannot modify the repo.
const registry = new ToolRegistry([
	new GlobTool(),
	new GrepTool(),
	new ReadTool(),
]);
const tools = registry.toJSONSchemas();
const bus = new EventBus();
const sessionId = `subscription-cli-smoke-${randomUUID()}`;
const session = new Session(sessionId);
const scheduler = new ToolScheduler(registry, bus);
const events: AgentEvent[] = [];
bus.onAny((event) => {
	events.push(event);
	const line = sampleLine(event);
	if (line) console.log(line);
});

console.log(`[cli] MODEL       ${model}`);
console.log(
	`[cli] TOOLS       ${tools.map((tool) => tool.function.name).join(", ")}`,
);

const loop = new AgentLoop({
	client,
	scheduler,
	session,
	bus,
	tools,
	systemPrompt:
		"You are running inside the Backboard CLI harness. Use the CLI tools exactly as requested and keep the final answer to one sentence.",
	model: { provider: "openai-subscription", model },
	memory: "off",
	memoryProfile: "code",
	thinking: { effort: "low" },
	requestKind: "user",
	finalVerificationNudge: false,
	todoReconciliation: false,
	maxToolRounds: 4,
});
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 45_000);
const status = await loop
	.run(
		'First call Glob with patterns ["package.json"] and path ".". Then call Read on the returned package.json path. Report its package name. You must use both tools and must not search outside the current working directory.',
		{
			sessionId,
			cwd,
			bus,
			signal: controller.signal,
			askUser: async () => "",
		},
	)
	.finally(() => clearTimeout(timeout));

const toolStarts = events.filter((event) => event.type === "tool:start");
if (status !== "completed" || toolStarts.length < 2) {
	throw new Error(
		`Expected a completed CLI turn with at least two tool calls; got ${status} and ${toolStarts.length}.`,
	);
}
console.log(
	`[cli] PASS        ${toolStarts.length} calls ran through ToolScheduler`,
);
