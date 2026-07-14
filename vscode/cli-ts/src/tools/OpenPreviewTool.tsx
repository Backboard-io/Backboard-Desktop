import { z } from "zod";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";

const schema = z.object({
	url: z
		.string()
		.describe(
			"URL of the local web app to preview, e.g. http://localhost:3000",
		),
});

type Input = z.infer<typeof schema>;

interface Output {
	url: string;
	reachable: boolean;
}

const PROBE_TIMEOUT_MS = 3_000;

/**
 * Announces a local web app (dev server) to the host so it can surface a live
 * preview — in the Backboard IDE this renders a preview card in the chat
 * transcript and opens the app in the Browser panel. The tool itself only
 * validates and probes the URL; the host reacts to the tool call.
 */
export class OpenPreviewTool extends Tool<Input, Output> {
	readonly name = "OpenPreview";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const url = normalizePreviewUrl(input.url);
		const reachable = await probe(url, ctx.signal);
		const note = reachable
			? `Preview available at ${url}. The user can now see the app.`
			: `Announced preview for ${url}, but nothing is responding there yet. If you just started the server, it may still be warming up; verify it is running.`;
		return ok({ url, reachable }, note, `Preview ${url}`);
	}
}

/** Coerces bare hosts/ports ("localhost:3000", ":3000", "3000") to http URLs. */
function normalizePreviewUrl(raw: string): string {
	const trimmed = raw.trim();
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed;
	const portOnly = /^:?(\d{2,5})(\/.*)?$/.exec(trimmed);
	if (portOnly) return `http://localhost:${portOnly[1]}${portOnly[2] ?? ""}`;
	return `http://${trimmed}`;
}

async function probe(url: string, signal: AbortSignal): Promise<boolean> {
	try {
		const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
		const res = await fetch(url, {
			signal: AbortSignal.any([signal, timeout]),
			redirect: "manual",
		});
		return typeof res.status === "number";
	} catch {
		return false;
	}
}
