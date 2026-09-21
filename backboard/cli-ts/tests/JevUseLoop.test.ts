import { describe, expect, it } from "bun:test";
import {
	describeElement,
	type JevDecider,
	type JevElement,
	type JevKey,
	type JevSurface,
	JevUseLoop,
	type JevWriter,
	pickCandidates,
	safeUrl,
	visibleText,
} from "../src/core/computer/JevUseLoop.ts";
import type { SystemOneRequest } from "../src/providers/backboard/types.ts";
import { parseWriterReply } from "../src/tools/index.ts";

/** A surface whose screens advance each time something acts on it. */
class FakeSurface implements JevSurface {
	readonly kind = "fake";
	readonly log: string[] = [];
	openUrl?: JevSurface["openUrl"];
	private screen = 0;

	constructor(
		private readonly screens: JevElement[][],
		options: { browser?: boolean; static?: boolean } = {},
	) {
		this.static = options.static ?? false;
		if (options.browser) {
			this.openUrl = async (url) => this.act(`open ${url}`);
		}
	}
	private readonly static: boolean;

	async observe() {
		return {
			appName: "App",
			windowTitle: `Screen ${Math.min(this.screen, this.screens.length - 1)}`,
			elements:
				this.screens[Math.min(this.screen, this.screens.length - 1)] ?? [],
			text: "",
		};
	}

	private act(entry: string) {
		this.log.push(entry);
		if (!this.static) this.screen++;
	}

	async press(element: JevElement) {
		this.act(`press ${element.label}`);
	}
	async type(element: JevElement, text: string) {
		this.act(`type ${JSON.stringify(text)} into ${element.label}`);
	}
	async key(key: JevKey) {
		this.act(`key ${key}`);
	}
	async scroll(direction: "up" | "down") {
		this.act(`scroll ${direction}`);
	}
}

const el = (label: string, role = "AXButton"): JevElement => ({
	handle: `h-${label}`,
	role,
	label,
});
const field = (label: string) => el(label, "AXTextField");

type Move =
	| "DONE"
	| "BLOCKED"
	| "WAIT"
	| "PRESS_ENTER"
	| "SCROLL_DOWN"
	| "OPEN_URL"
	| { click: RegExp }
	| { type: RegExp };

/** Scripts Jev: each move names an operation and, if needed, matches a target. */
function decider(
	moves: Move[],
	options: {
		confidence?: number;
		/** Probability of the chosen option; defaults to a clear winner. */
		probability?: number;
		complete?: number[];
		seen?: SystemOneRequest[];
	} = {},
): JevDecider {
	let turn = 0;
	return async (request) => {
		options.seen?.push(request);
		const move = moves[turn] ?? "DONE";
		const noul = options.complete?.[turn] ?? 0;
		turn++;
		const confidence = options.confidence ?? 0.9;
		const choice = (value: string) => ({
			type: "choice" as const,
			choice: value,
			confidence,
			probabilities: { [value]: options.probability ?? 0.9 },
		});
		const find = (name: string, pattern: RegExp) => {
			const question = request.questions[name];
			if (question?.type !== "choice") throw new Error(`no ${name} question`);
			const id = Object.entries(question.criteria).find(([, text]) =>
				pattern.test(text),
			)?.[0];
			if (!id) throw new Error(`no ${name} matching ${pattern}`);
			return id;
		};
		const answers: Record<string, ReturnType<typeof choice>> = {};
		if (typeof move === "string") {
			answers.operation = choice(move);
		} else if ("click" in move) {
			answers.operation = choice("CLICK");
			answers.click_target = choice(find("click_target", move.click));
		} else {
			answers.operation = choice("TYPE_TEXT");
			answers.type_target = choice(find("type_target", move.type));
		}
		return {
			thread_id: "t",
			model: "jev-test",
			answers: { complete: { type: "noul", noul }, ...answers },
		};
	};
}

const writer =
	(value: string | null, packets: unknown[] = []): JevWriter =>
	async (packet) => {
		packets.push(packet);
		return value;
	};

const run = (
	surface: JevSurface,
	decide: JevDecider,
	write: JevWriter = writer(null),
	goal = "Search for Justin Bieber and open his artist page",
) =>
	new JevUseLoop(surface, decide, write, 0, 0).run(
		{ goal },
		new AbortController().signal,
	);

describe("JevUseLoop", () => {
	it("carries a whole multi-step goal by itself: type, submit, click, finish", async () => {
		const surface = new FakeSurface([
			[field("Search"), el("Home")],
			[field("Search"), el("Home")],
			[el("Justin Bieber", "AXLink"), el("Home")],
			[el("Follow"), el("Play")],
		]);
		const packets: unknown[] = [];
		const result = await run(
			surface,
			decider([
				{ type: /Search/ },
				"PRESS_ENTER",
				{ click: /Justin Bieber/ },
				"DONE",
			]),
			writer("Justin Bieber", packets),
		);
		expect({
			outcome: result.outcome,
			log: surface.log,
			operations: result.steps.map((step) => step.operation),
			writerAskedFor: packets.map((p) => (p as { kind: string }).kind),
		}).toEqual({
			outcome: "done",
			log: [
				'type "Justin Bieber" into Search',
				"key return",
				"press Justin Bieber",
			],
			operations: ["TYPE_TEXT", "PRESS_ENTER", "CLICK", "DONE"],
			writerAskedFor: ["text"],
		});
	});

	it("asks one request with an operation head and a target head per verb", async () => {
		const seen: SystemOneRequest[] = [];
		await run(
			new FakeSurface([[field("Search"), el("Home")]]),
			decider(["DONE"], { seen }),
		);
		const request = seen[0];
		const criteria = (name: string) => {
			const question = request?.questions[name];
			return question?.type === "choice" ? question.criteria : undefined;
		};
		expect({
			questions: Object.keys(request?.questions ?? {}),
			// No PRESS_ENTER before anything was typed, no OPEN_URL outside a browser.
			operations: Object.keys(criteria("operation") ?? {}),
			click: criteria("click_target"),
			type: criteria("type_target"),
			state: Object.keys(request?.state ?? {}),
		}).toEqual({
			questions: ["complete", "operation", "click_target", "type_target"],
			operations: [
				"CLICK",
				"TYPE_TEXT",
				"PRESS_ESCAPE",
				"SCROLL_DOWN",
				"SCROLL_UP",
				"WAIT",
				"DONE",
				"BLOCKED",
			],
			click: { c1: 'AXButton "Home"' },
			type: { t1: 'AXTextField "Search"' },
			state: ["goal", "window", "controls", "visible_text", "recent_actions"],
		});
	});

	it("waits for a lazily built tree instead of giving up", async () => {
		// Regression: Spotify's first observation was empty and the run abstained.
		const surface = new FakeSurface([[], [], [el("Home")]]);
		let looks = 0;
		const observe = surface.observe.bind(surface);
		surface.observe = async () => {
			const seen = await observe();
			// The screen "loads" by itself on the third look.
			if (++looks < 3) return { ...seen, elements: [] };
			return { ...seen, elements: [el("Home")] };
		};
		const result = await run(surface, decider(["DONE"]));
		expect({ outcome: result.outcome, looks }).toEqual({
			outcome: "done",
			looks: 3,
		});
	});

	it("opens a website through the browser, never the address bar", async () => {
		const surface = new FakeSurface(
			[[field("smart search field")], [el("Home")]],
			{
				browser: true,
			},
		);
		const result = await run(
			surface,
			decider(["OPEN_URL", "DONE"]),
			writer("twitter.com"),
			"Go to twitter",
		);
		expect({ outcome: result.outcome, log: surface.log }).toEqual({
			outcome: "done",
			log: ["open https://twitter.com/"],
		});
	});

	it("navigates from a blank page instead of waiting for controls", async () => {
		// Regression: the clean browser starts on about:blank, and the run failed
		// with "exposes no controls" without ever being offered OPEN_URL.
		const surface = new FakeSurface([[], [el("Home")]], { browser: true });
		const result = await run(
			surface,
			decider(["OPEN_URL", "DONE"]),
			writer("wikipedia.org"),
		);
		expect({ outcome: result.outcome, log: surface.log }).toEqual({
			outcome: "done",
			log: ["open https://wikipedia.org/"],
		});
	});

	it("stops for the user when the goal does not supply a value", async () => {
		const surface = new FakeSurface([[field("Email")]]);
		const result = await run(
			surface,
			decider([{ type: /Email/ }]),
			writer(null),
		);
		expect({ outcome: result.outcome, log: surface.log }).toEqual({
			outcome: "needs_input",
			log: [],
		});
	});

	it("does not act once Jev judges the goal met, even if it still names a target", async () => {
		// Regression: live Jev re-pressed an already-on switch, turning it off.
		const surface = new FakeSurface([[el("Bluetooth", "AXCheckBox")]]);
		const result = await run(
			surface,
			decider([{ click: /Bluetooth/ }], { complete: [0.9] }),
		);
		expect({ outcome: result.outcome, log: surface.log }).toEqual({
			outcome: "done",
			log: [],
		});
	});

	it("refuses consequential controls and never offers password fields", async () => {
		const seen: SystemOneRequest[] = [];
		const surface = new FakeSurface([
			[el("Delete Account"), el("Password", "AXSecureTextField")],
		]);
		const result = await run(surface, decider([{ click: /Delete/ }], { seen }));
		expect({
			outcome: result.outcome,
			log: surface.log,
			typeTargetsOffered: "type_target" in (seen[0]?.questions ?? {}),
		}).toEqual({
			outcome: "needs_confirmation",
			log: [],
			typeTargetsOffered: false,
		});
	});

	it("acts on a near tie between two right moves, but not on noise", async () => {
		// Regression: real Spotify split 0.51 / 0.49 between CLICK and PRESS_ENTER,
		// both correct, and the old confidence floor abandoned the run.
		const tie = new FakeSurface([
			[el("Justin Bieber", "AXLink")],
			[el("Play")],
		]);
		const acted = await run(
			tie,
			decider([{ click: /Justin/ }, "DONE"], {
				confidence: 0.44,
				probability: 0.51,
			}),
		);
		const noise = new FakeSurface([[el("Network")]]);
		const refused = await run(
			noise,
			decider([{ click: /Network/ }], { confidence: 0.1, probability: 0.12 }),
		);
		expect({
			tie: [acted.outcome, tie.log],
			noise: [refused.outcome, noise.log],
		}).toEqual({
			tie: ["done", ["press Justin Bieber"]],
			noise: ["abstained", []],
		});
	});

	it("stalls after three actions that leave the screen unchanged", async () => {
		const surface = new FakeSurface([[el("Refresh")]], { static: true });
		const result = await run(
			surface,
			decider(Array(10).fill({ click: /Refresh/ })),
		);
		expect({ outcome: result.outcome, presses: surface.log.length }).toEqual({
			outcome: "stalled",
			presses: 3,
		});
	});

	it("fails closed when Jev answers outside the offered choices", async () => {
		const rogue: JevDecider = async () => ({
			thread_id: "t",
			model: "jev-test",
			answers: {
				operation: {
					type: "choice",
					choice: "FORMAT_DISK",
					confidence: 1,
					probabilities: {},
				},
			},
		});
		const surface = new FakeSurface([[el("Network")]]);
		const result = await run(surface, rogue);
		expect({ outcome: result.outcome, log: surface.log }).toEqual({
			outcome: "failed",
			log: [],
		});
	});

	it("reports each step as it happens and which surface ran", async () => {
		const live: string[] = [];
		const result = await new JevUseLoop(
			new FakeSurface([[el("Next")], [el("Finish")]]),
			decider([{ click: /Next/ }, "DONE"]),
			writer(null),
			0,
			0,
		).run(
			{ goal: "Finish setup", onStep: (step) => live.push(step.operation) },
			new AbortController().signal,
		);
		expect({ live, surface: result.surface }).toEqual({
			live: ["CLICK", "DONE"],
			surface: "fake",
		});
	});
});

describe("perception helpers", () => {
	it("keeps goal-relevant elements past the cap, in reading order", () => {
		const filler = Array.from({ length: 60 }, (_, i) => el(`Row ${i}`));
		const labels = pickCandidates(
			[...filler, el("Bluetooth")],
			"Turn on Bluetooth",
			29,
		).map((element) => element.label);
		// Ranking rescues "Bluetooth" from position 61, but must not move it to
		// the front: live Jev presses whatever goal-matching element leads the list.
		expect({
			size: labels.length,
			first: labels[0],
			last: labels.at(-1),
		}).toEqual({ size: 29, first: "Row 0", last: "Bluetooth" });
	});

	it("drops a list row that duplicates the link inside it", () => {
		expect(
			pickCandidates(
				[
					el("Drake", "AXRow"),
					el("Play Drake"),
					el("Drake", "AXLink"),
					el("Bluetooth", "AXRow"),
				],
				"",
				40,
			).map(describeElement),
		).toEqual(['AXButton "Play Drake"', 'AXLink "Drake"', 'AXRow "Bluetooth"']);
	});

	it("never offers the Apple menu, unlabelled buttons, or duplicates", () => {
		expect(
			pickCandidates(
				[
					el("Apple", "AXMenuBarItem"),
					el("OK"),
					el("OK"),
					{ handle: "x", role: "AXButton" },
				],
				"",
				40,
			).map((element) => element.handle),
		).toEqual(["h-OK"]);
	});

	it("spells out toggle, field, and selection state", () => {
		expect(
			[
				{ handle: "a", role: "AXCheckBox", label: "Bluetooth", value: "1" },
				{ handle: "b", role: "AXSwitch", label: "Wi-Fi", value: "off" },
				{ handle: "c", role: "AXTextField", label: "Search", value: "wifi" },
				{ handle: "d", role: "AXRow", label: "General", selected: true },
			].map(describeElement),
		).toEqual([
			'AXCheckBox "Bluetooth" (currently ON)',
			'AXSwitch "Wi-Fi" (currently OFF)',
			'AXTextField "Search" (currently "wifi")',
			'AXRow "General" (selected)',
		]);
	});

	it("only opens plain https addresses", () => {
		expect(
			[
				"twitter.com",
				"https://www.linkedin.com/feed",
				"http://example.com",
				"javascript:alert(1)",
				"file:///etc/passwd",
				"https://user:pw@evil.com",
				"localhost",
				null,
			].map(safeUrl),
		).toEqual([
			"https://twitter.com/",
			"https://www.linkedin.com/feed",
			null,
			null,
			null,
			null,
			null,
			null,
		]);
	});

	it("drops per-letter animated headings from visible text", () => {
		expect(
			visibleText(["G", "e", "t", "Get started", "Get started", "Docs"]),
		).toBe("Get started\nDocs");
	});

	it("accepts only a well-formed writer reply", () => {
		expect(
			[
				'{"text": "Justin Bieber"}',
				'Sure! {"text": "x.com"}',
				'{"text": null}',
				'{"text": ""}',
				"Justin Bieber",
			].map(parseWriterReply),
		).toEqual(["Justin Bieber", "x.com", null, null, null]);
	});
});
