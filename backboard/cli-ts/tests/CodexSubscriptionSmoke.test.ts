import { describe, expect, it } from "bun:test";
import {
	buildResponsesRequest,
	buildSubscriptionHeaders,
	collectResponseEvent,
	parseModelsResponse,
} from "../src/providers/subscription/CodexSubscriptionSmoke.ts";

describe("Codex subscription smoke adapter", () => {
	it("builds subscription headers without exposing tokens in the request body", () => {
		const headers = buildSubscriptionHeaders(
			{ accessToken: "secret-token", accountId: "account-1" },
			"session-1",
		);
		const request = buildResponsesRequest(
			"gpt-test",
			[
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "probe" }],
				},
			],
			"required",
			"session-1",
		);

		expect(headers.get("authorization")).toBe("Bearer secret-token");
		expect(headers.get("chatgpt-account-id")).toBe("account-1");
		expect(headers.get("originator")).toBe("backboard_cli_ts");
		expect(JSON.stringify(request)).not.toContain("secret-token");
		expect(request.tool_choice).toBe("required");
		expect(request.store).toBe(false);
	});

	it("selects visible API models by priority", () => {
		expect(
			parseModelsResponse({
				models: [
					{ slug: "later", priority: 20, visibility: "list" },
					{ slug: "hidden", priority: 0, visibility: "hide" },
					{ slug: "unsupported", priority: 1, supported_in_api: false },
					{ slug: "first", priority: 10, visibility: "list" },
				],
			}),
		).toEqual(["first", "later"]);
	});

	it("collects output items and text deltas from Responses SSE events", () => {
		const result = { outputItems: [], text: "" };
		collectResponseEvent(
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					name: "backboard_probe",
					call_id: "call-1",
					arguments: '{"message":"hello"}',
				},
			},
			result,
		);
		collectResponseEvent(
			{ type: "response.output_text.delta", delta: "done" },
			result,
		);

		expect(result.outputItems).toHaveLength(1);
		expect(result.text).toBe("done");
	});
});
