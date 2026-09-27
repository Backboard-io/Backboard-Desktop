import { describe, expect, it } from "bun:test";
import { JevBrain, type JevDecider } from "../src/core/computer/JevBrain.ts";
import { JevStaleTargetError } from "../src/core/computer/JevSurfaceError.ts";
import {
	describeElement,
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
	new JevUseLoop(surface, new JevBrain(decide), write, 0, 0).run(
		{ goal },
		new AbortController().signal,
	);

describe("JevUseLoop", () => {
	it("allows 60 decisions by default and clamps explicit budgets at 180", async () => {
		for (const [maxSteps, expected] of [
			[undefined, 60],
			[1000, 180],
		] as const) {
			const result = await new JevUseLoop(
				new FakeSurface([[el("Editor")]], { static: true }),
				new JevBrain(decider(Array<Move>(200).fill("SCROLL_DOWN"))),
				writer(null),
				0,
				0,
			).run(
				{ goal: "Find the next section", maxSteps },
				new AbortController().signal,
			);
			expect(result.outcome).toBe("budget_exhausted");
			expect(result.steps).toHaveLength(expected);
		}
	});
	it("keeps late overlay controls available on a busy editor page", async () => {
		const surface = new FakeSurface([
			[
				...Array.from({ length: 125 }, (_, n) => el(`Tool ${n}`)),
				el("Close welcome"),
			],
			[],
		]);
		await run(surface, decider([{ click: /Close welcome/ }, "DONE"]));
		expect(surface.log).toEqual(["press Close welcome"]);
	});
	it("discards composed text if the page changes while the writer runs", async () => {
		const surface = new FakeSurface([[field("Recipient")]]);
		const observe = surface.observe.bind(surface);
		let changed = false;
		surface.observe = async () => ({
			...(await observe()),
			windowTitle: changed ? "Another page" : "Original page",
		});
		const result = await run(
			surface,
			decider([{ type: /Recipient/ }, "BLOCKED"]),
			async () => {
				changed = true;
				return "alice@example.com";
			},
		);
		expect(surface.log).toEqual([]);
		expect(result.steps[0]?.operation).toBe("WAIT");
	});
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
			noise: ["budget_exhausted", []],
		});
	});

	it("tries another control instead of quitting after unchanged clicks", async () => {
		const seen: SystemOneRequest[] = [];
		const surface = new FakeSurface([[el("Refresh"), el("Continue")]], {
			static: true,
		});
		const result = await run(
			surface,
			decider(
				[
					{ click: /Refresh/ },
					{ click: /Refresh/ },
					{ click: /Continue/ },
					"DONE",
				],
				{ seen },
			),
		);
		expect(result.outcome).toBe("done");
		expect(surface.log).toEqual([
			"press Refresh",
			"press Refresh",
			"press Continue",
		]);
		expect(JSON.stringify(seen[2]?.questions.click_target)).not.toContain(
			"Refresh",
		);
	});

	it("withholds covered controls until the overlay changes, then allows them again", async () => {
		const seen: SystemOneRequest[] = [];
		const surface = new FakeSurface([
			[el("Create"), el("Dialog close"), el("Announcement close")],
			[el("Create")],
			[el("Brush")],
		]);
		const press = surface.press.bind(surface);
		surface.press = async (target) => {
			if (!surface.log.length && target.label !== "Announcement close")
				throw new JevStaleTargetError("Target has no unobstructed hit point");
			return press(target);
		};
		const result = await run(
			surface,
			decider(
				[
					{ click: /Create/ },
					{ click: /Dialog close/ },
					{ click: /Announcement close/ },
					{ click: /Create/ },
					"DONE",
				],
				{ seen },
			),
		);
		expect(result.outcome).toBe("done");
		expect(surface.log).toEqual(["press Announcement close", "press Create"]);
		expect(JSON.stringify(seen[2]?.questions.click_target)).not.toMatch(
			/Create|Dialog close/,
		);
	});

	it("does not treat three unchanged text observations as proof that actions failed", async () => {
		const surface = new FakeSurface([[el("Editor")]], { static: true });
		const result = await run(
			surface,
			decider([
				"SCROLL_DOWN",
				"SCROLL_DOWN",
				"SCROLL_DOWN",
				"SCROLL_DOWN",
				"DONE",
			]),
		);
		expect(result.outcome).toBe("done");
		expect(surface.log).toHaveLength(4);
	});

	it("waits through more than five loading observations and resumes", async () => {
		const result = await run(
			new FakeSurface([[el("Loading")]]),
			decider([...Array<Move>(8).fill("WAIT"), "DONE"]),
		);
		expect(result.outcome).toBe("done");
		expect(result.steps).toHaveLength(9);
	});

	it("bounds loading by elapsed time, not three or five decisions", async () => {
		let now = 0;
		const scripted = decider(Array<Move>(30).fill("WAIT"));
		const result = await new JevUseLoop(
			new FakeSurface([[el("Loading")]]),
			new JevBrain(async (request, options) => {
				now += 10_000;
				return scripted(request, options);
			}),
			writer(null),
			0,
			0,
			() => now,
		).run({ goal: "Wait for the editor" }, new AbortController().signal);
		expect(result.outcome).toBe("stalled");
		expect(result.steps).toHaveLength(13);
		expect(result.error).toContain("120 seconds");
	});

	it("refreshes after an uncertain choice and can recover on the next decision", async () => {
		const surface = new FakeSurface([[el("Next")], [el("Complete")]]);
		const uncertain = decider([{ click: /Next/ }], { probability: 0.1 });
		const clear = decider([{ click: /Next/ }, "DONE"]);
		let calls = 0;
		const result = await run(surface, (request, options) =>
			(++calls === 1 ? uncertain : clear)(request, options),
		);
		expect(result.outcome).toBe("done");
		expect(result.steps.map((step) => step.operation)).toEqual([
			"WAIT",
			"CLICK",
			"DONE",
		]);
		expect(surface.log).toEqual(["press Next"]);
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

	it("reports each step as it happens and which surface and brain ran", async () => {
		const live: string[] = [];
		const result = await new JevUseLoop(
			new FakeSurface([[el("Next")], [el("Finish")]]),
			new JevBrain(decider([{ click: /Next/ }, "DONE"])),
			writer(null),
			0,
			0,
		).run(
			{ goal: "Finish setup", onStep: (step) => live.push(step.operation) },
			new AbortController().signal,
		);
		expect({ live, surface: result.surface, brain: result.brain }).toEqual({
			live: ["CLICK", "DONE"],
			surface: "fake",
			brain: "jev",
		});
	});
});

describe("perception helpers", () => {
	it("preserves late modal text when a long editor outline is clipped", () => {
		const text = visibleText([
			"Editor heading",
			...Array.from(
				{ length: 200 },
				(_, i) => `Tool ${i} with a long descriptive label in the editor`,
			),
			"Sign in to continue",
			"Continue with Google",
			"Close login",
		]);
		expect(text.length).toBeLessThanOrEqual(6000);
		expect(text).toContain("Editor heading");
		expect(text).toContain("Sign in to continue");
		expect(text).toContain("Close login");
	});
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
