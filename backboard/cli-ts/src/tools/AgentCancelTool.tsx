/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { z } from "zod";
import type { AgentTaskManager } from "../core/agent/AgentTaskManager.ts";
import { Tool } from "../core/tools/Tool.ts";
import { throwIfAborted } from "../core/tools/ToolAbort.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
const schema = z.object({ handles: z.array(z.string().min(1)).min(1).max(4).describe("Session-owned worker handles to request cancellation for.") });
export class AgentCancelTool extends Tool<z.infer<typeof schema>> {
	readonly name = "AgentCancel";
	readonly inputSchema = schema;
	constructor(private readonly tasks: AgentTaskManager) { super(); }
	override prompt(context: PromptContext = {}): string { return getToolPrompt(this.name, context); }
	override isConcurrencySafe(): boolean { return false; }
	override checkPermissions() { return { behavior: "allow" as const, reason: "cancel session-owned workers" }; }
	override async execute(input: z.infer<typeof schema>, ctx: ToolContext) {
		throwIfAborted(ctx.signal);
		const tasks = await this.tasks.cancel([...new Set(input.handles)], ctx.sessionId);
		return ok({ tasks: tasks.map(({ handle, status }) => ({ handle, status })) }, "Cancellation requested. Use AgentWait to observe the final outcomes. Already captured or integrated changes remain durable and are not rolled back.", "Worker cancellation requested");
	}
}
