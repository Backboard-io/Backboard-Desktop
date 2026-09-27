import { describe, expect, it } from "bun:test";
import { agentProfileName } from "../src/core/computer/CuaBrowserSurface.ts";
import type {
	JevElement,
	JevKey,
	JevSurface,
	ScreenImage,
} from "../src/core/computer/JevUseLoop.ts";
import { JevUseLoop } from "../src/core/computer/JevUseLoop.ts";
import {
	ModelBrain,
	type ModelSender,
} from "../src/core/computer/ModelBrain.ts";
import type {
	ModelRoute,
	SendMessageRequest,
} from "../src/providers/backboard/types.ts";
import { computerUseRoutes } from "../src/tools/index.ts";

const SHOT: ScreenImage = { path: "/tmp/shot.png", width: 1280, height: 760 };

/** Screens advance each time something acts on the surface. */
class FakeSurface implements JevSurface {
	readonly kind = "fake";
	readonly log: string[] = [];
	private screen = 0;

	constructor(
		private readonly screens: JevElement[][],
		private readonly shot?: ScreenImage,
	) {}

	async observe() {
		const index = Math.min(this.screen, this.screens.length - 1);
		return {
			appName: "Spotify",
			windowTitle: `Screen ${index}`,
			elements: this.screens[index] ?? [],
			text: "",
			...(this.shot ? { screenshot: this.shot } : {}),
		};
	}
	async pressAt(x: number, y: number) {
		this.log.push(`click ${x},${y}`);
		this.screen++;
	}
	async press(element: JevElement) {
		this.log.push(`press ${element.label}`);
		this.screen++;
	}
	async type(element: JevElement, text: string) {
		this.log.push(`type ${JSON.stringify(text)} into ${element.label}`);
	}
	async key(key: JevKey) {
		this.log.push(`key ${key}`);
		this.screen++;
	}
	async scroll(direction: "up" | "down") {
		this.log.push(`scroll ${direction}`);
	}
}

const el = (label: string, role = "AXButton"): JevElement => ({
	handle: `h-${label}`,
	role,
	label,
});

/** Replies with one scripted tool call per request, `null` for prose. */
function sender(
	calls: Array<[string, Record<string, unknown>] | null>,
	requests: SendMessageRequest[] = [],
): ModelSender {
	let turn = 0;
	return async (request) => {
		requests.push(request);
		const call =
			turn < calls.length
				? calls[turn]
				: (["done", { summary: "Finished." }] as const);
		turn++;
		return {
			thread_id: "t",
			content: call ? null : "I think I should click Search.",
			status: call ? "REQUIRES_ACTION" : "COMPLETED",
			tool_calls: call
				? [
						{
							id: `call_${turn}`,
							type: "function",
							function: { name: call[0], arguments: JSON.stringify(call[1]) },
						},
					]
				: null,
		};
	};
}

const FAST: ModelRoute = {
	provider: "openrouter",
	model: "deepseek/deepseek-v4.1-flash",
	source: "backboard",
};

const run = (
	surface: JevSurface,
	send: ModelSender,
	options: {
		routes?: ModelRoute[];
		status?: string[];
		/** Answers to mid-run questions, in order; each question is logged. */
		answers?: string[];
		asked?: string[];
	} = {},
) =>
	new JevUseLoop(
		surface,
		new ModelBrain({
			routes: options.routes ?? [FAST],
			send,
			onStatus: (message) => options.status?.push(message),
		}),
		async () => {
			throw new Error("the model writes its own text");
		},
		0,
		0,
	).run(
		{
			goal: "Search for Justin Bieber and open his artist page",
			...(options.answers
				? {
						ask: async (question: string, choices: string[]) => {
							options.asked?.push(`${question} [${choices.join(" | ")}]`);
							return options.answers?.shift() ?? "";
						},
					}
				: {}),
		},
		new AbortController().signal,
	);

describe("ModelBrain", () => {
	it("types, submits, and clicks with its own text, one request per step", async () => {
		const surface = new FakeSurface([
			[el("Home"), el("What do you want to play?", "AXTextField")],
			[el("Justin Bieber", "AXLink"), el("Home")],
			[el("Follow"), el("Play")],
		]);
		const requests: SendMessageRequest[] = [];
		const result = await run(
			surface,
			sender(
				[
					["type_text", { id: "t1", text: "Justin Bieber", submit: true }],
					["click", { id: "c1" }],
					["done", { summary: "The artist page shows Follow and Play." }],
				],
				requests,
			),
		);
		const first = requests[0];
		expect({
			outcome: result.outcome,
			brain: result.brain,
			summary: result.summary,
			log: surface.log,
			steps: result.steps.map((step) =>
				[step.operation, step.target, step.text, step.submitted]
					.filter(Boolean)
					.join(" | "),
			),
			request: {
				model: `${first?.llm_provider}/${first?.model_name}`,
				source: first?.source,
				thinking: first?.thinking,
				openrouter: first?.openrouter,
				memory: first?.memory,
				tools: first?.tools?.map((tool) => tool.function.name),
			},
			listsIds: first?.content.includes(
				't1 AXTextField "What do you want to play?"',
			),
			historyInSecondTurn: requests[1]?.content.includes(
				'1. TYPE_TEXT AXTextField "What do you want to play?" text "Justin Bieber" then pressed Return',
			),
		}).toEqual({
			outcome: "done",
			brain: "openrouter/deepseek/deepseek-v4.1-flash",
			summary:
				"The agent reported the goal complete after 3 step(s). The artist page shows Follow and Play.",
			log: [
				'type "Justin Bieber" into What do you want to play?',
				"key return",
				"press Justin Bieber",
			],
			steps: [
				'TYPE_TEXT | AXTextField "What do you want to play?" | Justin Bieber | true',
				'CLICK | AXLink "Justin Bieber"',
				"DONE | The artist page shows Follow and Play.",
			],
			request: {
				model: "openrouter/deepseek/deepseek-v4.1-flash",
				source: "backboard",
				thinking: null,
				openrouter: { sort: "latency" },
				memory: "off",
				// No press_enter before anything was typed, no open_url outside a browser.
				tools: [
					"click",
					"type_text",
					"press_escape",
					"scroll_down",
					"scroll_up",
					"wait",
					"done",
					"blocked",
					"hand_off",
					"ask_user",
				],
			},
			listsIds: true,
			historyInSecondTurn: true,
		});
	});

	it("corrects an invalid reply, and fails closed after three", async () => {
		const recovered = new FakeSurface([[el("Next")], [el("Finish")]]);
		const requests: SendMessageRequest[] = [];
		const ok = await run(
			recovered,
			sender(
				[
					["click", { id: "c9" }],
					["click", { id: "c1" }],
				],
				requests,
			),
		);
		const rogue = new FakeSurface([[el("Network")]]);
		const failed = await run(
			rogue,
			sender([
				null,
				["open_url", { url: "https://example.com" }],
				["click", { id: "c7" }],
			]),
		);
		expect({
			ok: ok.outcome,
			pressed: recovered.log,
			nudge: requests[1]?.content.split("\n").at(-1),
			failed: failed.outcome,
			error: failed.error,
			untouched: rogue.log,
		}).toEqual({
			ok: "done",
			pressed: ["press Next"],
			nudge:
				'Your previous reply called click with id "c9", which is not in the Controls list. Call exactly one of the available tools; if the goal is already met, call done.',
			failed: "failed",
			error:
				'openrouter/deepseek/deepseek-v4.1-flash chose no valid action: its reply called click with id "c7", which is not in the Controls list.',
			untouched: [],
		});
	});

	it("hands a missing value back to the user instead of inventing it", async () => {
		const surface = new FakeSurface([[el("To", "AXTextField"), el("Send")]]);
		const result = await run(
			surface,
			sender([["ask_user", { question: "Who should the email go to?" }]]),
		);
		expect({
			outcome: result.outcome,
			error: result.error,
			log: surface.log,
		}).toEqual({
			outcome: "needs_input",
			error: "Ask the user: Who should the email go to?",
			log: [],
		});
	});

	it("retries a failed request once, then falls back to the session's model", async () => {
		const session: ModelRoute = {
			provider: "anthropic",
			model: "claude-sonnet-5",
			source: "byok",
		};
		const status: string[] = [];
		const used: string[] = [];
		const send = sender([["click", { id: "c1" }]]);
		const result = await run(
			new FakeSurface([[el("Next")], [el("Finish")]]),
			async (request, options) => {
				used.push(`${request.llm_provider}/${request.model_name}`);
				if (request.llm_provider === "openrouter")
					throw new Error("No Backboard account");
				return send(request, options);
			},
			{ routes: [FAST, session], status },
		);
		expect({
			outcome: result.outcome,
			brain: result.brain,
			used,
			status,
		}).toEqual({
			outcome: "done",
			brain: "anthropic/claude-sonnet-5",
			used: [
				"openrouter/deepseek/deepseek-v4.1-flash",
				"openrouter/deepseek/deepseek-v4.1-flash",
				"anthropic/claude-sonnet-5",
				"anthropic/claude-sonnet-5",
			],
			status: [
				"openrouter/deepseek/deepseek-v4.1-flash failed (No Backboard account); retrying",
				"openrouter/deepseek/deepseek-v4.1-flash failed again; continuing with anthropic/claude-sonnet-5",
			],
		});
	});

	it("sees the screenshot and clicks a point no control covers", async () => {
		const surface = new FakeSurface([[el("Home")], [el("Post")]], SHOT);
		const attached: string[][] = [];
		const send = sender([
			["click_at", { x: 493, y: 153, what: "Start a post box" }],
		]);
		const result = await run(surface, async (request, options) => {
			attached.push(options.attachments);
			return send(request, options);
		});
		expect({
			outcome: result.outcome,
			attached: attached[0],
			log: surface.log,
			step: result.steps[0]?.target,
		}).toEqual({
			outcome: "done",
			attached: ["/tmp/shot.png"],
			// 0-1000 grid scaled to the 1280x760 screenshot.
			log: ["click 631,116"],
			step: 'point 493,153 "Start a post box"',
		});
	});

	it("waits for the user to sign in themselves, then carries on", async () => {
		const surface = new FakeSurface([
			[
				el("Email or phone", "textbox"),
				{ ...el("Password", "textbox"), editable: true },
				el("Sign in", "AXLink"),
			],
			[el("Home")],
		]);
		const asked: string[] = [];
		const requests: SendMessageRequest[] = [];
		const result = await run(
			surface,
			sender(
				[
					[
						"hand_off",
						{
							instruction:
								"Sign in to LinkedIn in the Backboard browser window.",
						},
					],
					["done", { summary: "The feed is showing." }],
				],
				requests,
			),
			{ answers: ["Done, continue"], asked },
		);
		const stopped = await run(
			new FakeSurface([[el("Sign in", "AXLink")]]),
			sender([["hand_off", { instruction: "Sign in to LinkedIn." }]]),
			{ answers: ["Stop the task"] },
		);
		expect({
			outcome: result.outcome,
			// A DOM password box is a plain textbox; it is recognised by label.
			offersEmailField: requests[0]?.content.includes('"Email or phone"'),
			offersPasswordField: requests[0]?.content.includes('"Password"'),
			asked,
			steps: result.steps.map((step) => step.operation),
			typedNothing: surface.log,
			stopped: stopped.outcome,
		}).toEqual({
			outcome: "done",
			offersEmailField: true,
			offersPasswordField: false,
			asked: [
				"Sign in to LinkedIn in the Backboard browser window. [Done, continue | Stop the task]",
			],
			steps: ["HAND_OFF", "DONE"],
			typedNothing: [],
			stopped: "declined",
		});
	});

	it("asks before a consequential control and respects the answer", async () => {
		const script = () =>
			sender([
				["type_text", { id: "t1", text: "Hello from Backboard" }],
				["click", { id: "c1" }],
			]);
		const screens = () => [
			[el("Post"), el("What do you want to talk about?", "AXTextArea")],
		];
		const allowed = new FakeSurface(screens());
		const asked: string[] = [];
		const ok = await run(allowed, script(), {
			answers: ["Allow"],
			asked,
		});
		const refused = new FakeSurface(screens());
		const no = await run(refused, script(), { answers: ["Stop the task"] });
		expect({
			asked,
			ok: ok.outcome,
			pressed: allowed.log,
			no: no.outcome,
			notPressed: refused.log,
		}).toEqual({
			asked: [
				'Let the agent press AXButton "Post" in Spotify? [Allow | Stop the task]',
			],
			ok: "done",
			pressed: [
				'type "Hello from Backboard" into What do you want to talk about?',
				"press Post",
			],
			no: "declined",
			notPressed: [
				'type "Hello from Backboard" into What do you want to talk about?',
			],
		});
	});

	it("keeps one persistent agent profile per browser", () => {
		expect(["Browser", "Brave", "Google Chrome"].map(agentProfileName)).toEqual(
			["backboard", "backboard-brave-browser", "backboard-google-chrome"],
		);
	});

	it("bills the fast model to Backboard only when the turn carries a route", () => {
		const fast = {
			provider: "openrouter",
			model: "deepseek/deepseek-v4.1-flash",
		};
		expect({
			hostManaged: computerUseRoutes(fast, {
				provider: "openrouter",
				model: "moonshotai/kimi-k3",
				source: "subscription",
			}),
			standalone: computerUseRoutes(fast, {
				provider: "openrouter",
				model: "moonshotai/kimi-k3",
			}),
			sameModel: computerUseRoutes(fast, { ...fast, source: "backboard" }),
			// A subscription model bills its subscription, never Backboard.
			subscriptionBrain: computerUseRoutes(
				{ provider: "anthropic-subscription", model: "claude-sonnet-5" },
				{
					provider: "openrouter",
					model: "moonshotai/kimi-k3",
					source: "backboard",
				},
			)[0],
			// The user's own key serves a model from the same provider.
			ownKey: computerUseRoutes(fast, {
				provider: "openrouter",
				model: "moonshotai/kimi-k3",
				source: "byok",
			})[0],
		}).toEqual({
			hostManaged: [
				{ ...fast, source: "backboard" },
				{
					provider: "openrouter",
					model: "moonshotai/kimi-k3",
					source: "subscription",
				},
			],
			standalone: [
				fast,
				{ provider: "openrouter", model: "moonshotai/kimi-k3" },
			],
			sameModel: [{ ...fast, source: "backboard" }],
			subscriptionBrain: {
				provider: "anthropic-subscription",
				model: "claude-sonnet-5",
				source: "subscription",
			},
			ownKey: { ...fast, source: "byok" },
		});
	});
});
