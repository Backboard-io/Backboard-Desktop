#!/usr/bin/env bun
/** Live, opt-in test of the production Computer tool. Uses Backboard credentials
 * and the configured writer model. Leaves decision logs and a final screenshot;
 * a DONE decision alone is never treated as independent proof of the picture. */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Config } from "../src/config/Config.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { CuaBrowserSurface } from "../src/core/computer/CuaBrowserSurface.ts";
import { JEV_DEFAULT_MAX_STEPS } from "../src/core/computer/JevUseLoop.ts";
import { BackboardClient } from "../src/providers/backboard/BackboardClient.ts";
import { createJevComputerTool } from "../src/tools/index.ts";

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		app: { type: "string", default: "Brave" },
		goal: {
			type: "string",
			default: "open pixlr on brave and draw a picture of a cat",
		},
		output: { type: "string" },
		model: { type: "string" },
		"start-url": { type: "string" },
		steps: { type: "string", default: String(JEV_DEFAULT_MAX_STEPS) },
	},
});
const directory = values.output
	? resolve(values.output)
	: await mkdtemp(join(tmpdir(), "backboard-computer-"));
await mkdir(directory, { recursive: true });
const draw = CuaBrowserSurface.prototype.draw;
let drawingNumber = 0;
CuaBrowserSurface.prototype.draw = async function (element, drawing, signal) {
	await Bun.write(
		join(directory, `drawing-${++drawingNumber}.json`),
		JSON.stringify({ element, drawing }, null, 2),
	);
	return draw.call(this, element, drawing, signal);
};
if (values["start-url"]) {
	const observe = CuaBrowserSurface.prototype.observe;
	const initialized = new WeakSet<CuaBrowserSurface>();
	CuaBrowserSurface.prototype.observe = async function (signal) {
		if (!initialized.has(this)) {
			initialized.add(this);
			await this.openUrl(values["start-url"] as string, signal);
		}
		return observe.call(this, signal);
	};
}
const config = new Config({
	argv: values.model ? ["--model", values.model] : [],
});
const client = new BackboardClient(config.env);
const systemOne = client.systemOne.bind(client);
let decision = 0;
client.systemOne = async (request, options) => {
	const n = ++decision;
	await Bun.write(
		join(directory, `decision-${n}.json`),
		JSON.stringify(request, null, 2),
	);
	const result = await systemOne(request, options);
	await Bun.write(
		join(directory, `answer-${n}.json`),
		JSON.stringify(result, null, 2),
	);
	return result;
};
const bus = new EventBus();
bus.on("tool:progress", (event) => {
	if (event.data.kind === "terminal-output")
		process.stdout.write(event.data.text);
});
const tool = createJevComputerTool({ client, config });
console.log(`Live Computer test in ${values.app}; artifacts: ${directory}`);
try {
	const result = await tool.execute(
		tool.parseInput({
			actions: [
				{
					action: "task",
					appName: values.app,
					goal: values.goal,
					maxSteps: Number(values.steps),
				},
			],
		}),
		{
			sessionId: `computer-smoke-${Date.now()}`,
			toolCallId: "computer-smoke",
			cwd: process.cwd(),
			bus,
			signal: AbortSignal.timeout(10 * 60_000),
			modelRoute: { ...config.model, source: "backboard" },
			askUser: async () => {
				throw new Error("The live smoke test needs user input.");
			},
		},
	);
	const json = JSON.stringify(
		result.data,
		(key, value) => (key === "__image_base64" ? undefined : value),
		2,
	);
	await Bun.write(join(directory, "result.json"), json);
	console.log(json);
	console.log(
		"Inspect the final screenshot independently; Jev's DONE choice is not visual verification.",
	);
	if (!result.data.success) process.exitCode = 1;
} finally {
	await tool.dispose();
}
