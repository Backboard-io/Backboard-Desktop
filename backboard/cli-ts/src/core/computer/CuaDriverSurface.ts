import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CuaDriverClient } from "./CuaDriverClient.ts";
import {
	type JevElement,
	type JevKey,
	type JevObservation,
	type JevSurface,
	visibleText,
} from "./JevUseLoop.ts";

/** Overrides the bundled driver; also how a dev build points at a local one. */
export const CUA_DRIVER_BIN_ENV = "BACKBOARD_CUA_DRIVER_BIN";

/**
 * Finds the driver: an explicit override, the copy shipped beside this
 * executable, the copy a source checkout builds (`scripts/build-cua-driver.sh`),
 * then one the user installed themselves. Absent means the caller falls back
 * to the built-in platform layer.
 *
 * The checkout path matters: a dev runtime runs under Bun, so "beside this
 * executable" is Bun's directory, and relying on the IDE host to pass the
 * override silently failed whenever the host predated the driver.
 */
export function resolveCuaDriverBinary(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const name = process.platform === "win32" ? "cua-driver.exe" : "cua-driver";
	const override = env[CUA_DRIVER_BIN_ENV]?.trim();
	if (override) return existsSync(override) ? override : undefined;
	const candidates = [
		join(dirname(process.execPath), name),
		// <checkout>/cli-ts/src/core/computer -> <checkout>/extensions/backboard/bin
		join(
			import.meta.dir,
			"../../../..",
			"extensions",
			"backboard",
			"bin",
			name,
		),
	];
	return (
		candidates.find((path) => existsSync(path)) ?? Bun.which(name) ?? undefined
	);
}

/**
 * The driver's own default. The walk is depth-first and a browser's page comes
 * before its toolbar, so a lower cap (400 was tried) ends inside the page and
 * the address bar is never seen. 2000 nodes of Safari measured ~600 ms.
 */
const MAX_ELEMENTS = 2000;

/**
 * Containers and page text. Inside web content these all claim `AXPress`, so
 * an animated heading alone produced 319 single-letter "buttons" that pushed
 * every real control out of Jev's choice space.
 */
const NOT_A_CONTROL =
	/^AX(StaticText|Image|Heading|WebArea|Window|Group|ScrollArea|SplitGroup|Toolbar|List|Outline|Table|Unknown|MenuBar|MenuBarItem|Menu|MenuItem)$/;
// Menus are excluded wholesale: the tree lists every item of every closed
// menu. Safari's History menu alone added hundreds of entries that matched the
// goal's words and took all of Jev's slots, and the Apple menu holds Shut Down.

/** Text that is read, not pressed. It is evidence for the agent, not a target. */
const READABLE = /^AX(StaticText|Heading)$/;

const BROWSERS =
	/\b(safari|chrome|chromium|arc|brave|edge|firefox|opera|vivaldi|orion|dia)\b/i;

/** "Browser", or any browser by name: a task that belongs on the DOM surface. */
export function isBrowserApp(appName: string): boolean {
	return /\bbrowser\b/i.test(appName) || BROWSERS.test(appName);
}

/** Native lists label a row with a child text node rather than on the row. */
const ROW_ROLES = /^AX(Row|Cell)$/;
const WINDOW_WAIT_ATTEMPTS = 10;
const WINDOW_WAIT_MS = 400;

interface DriverWindow {
	pid: number;
	window_id: number;
	app_name?: string;
	title?: string;
	is_on_screen?: boolean;
	z_index?: number;
	bounds?: { width: number; height: number };
}

interface DriverApp {
	name: string;
	bundle_id?: string;
	running?: boolean;
}

/**
 * Exact name first, then a name that starts with or contains the request as
 * whole words. A running app wins a tie; an ambiguous request matches nothing
 * rather than guessing which app to drive.
 */
export function resolveAppName(
	requested: string,
	apps: readonly DriverApp[],
): DriverApp | undefined {
	const norm = (value: string) =>
		value
			.toLowerCase()
			.replace(/\.app$/, "")
			.replace(/\s+/g, " ")
			.trim();
	const wanted = norm(requested);
	if (!wanted) return undefined;
	const exact = apps.filter((app) => norm(app.name) === wanted);
	if (exact.length) return exact.find((app) => app.running) ?? exact[0];
	const words = (value: string) => norm(value).split(" ");
	const partial = apps.filter((app) => {
		const have = words(app.name);
		return words(wanted).every((word) => have.includes(word));
	});
	const running = partial.filter((app) => app.running);
	if (running.length === 1) return running[0];
	return partial.length === 1 ? partial[0] : undefined;
}

interface DriverElement {
	element_token?: string;
	role?: string;
	label?: string;
	value?: string;
	enabled?: boolean;
	in_web_content?: boolean;
	selected?: boolean;
	element_index?: number;
	parent_index?: number;
}

/**
 * Drives one app window through the open-source Cua Driver
 * (https://github.com/trycua/cua, MIT) over a persistent stdio MCP connection.
 *
 * Elements are pressed by `element_token` through the accessibility API, so
 * the pointer never moves and the target app stays in the background. The
 * tree is requested without a screenshot: no pixels are captured at all.
 */
export class CuaDriverSurface implements JevSurface {
	readonly kind = "cua-driver";
	private readonly driver: CuaDriverClient;
	private window: DriverWindow | null = null;
	private fallbackWindows: DriverWindow[] = [];
	private windowResolved = false;
	private launchBy: { name: string } | { bundle_id: string } | null = null;
	private lastElements: JevElement[] = [];
	/** Role and label of the field last typed into, so Return can find it again. */
	private lastTyped: { role: string; label?: string } | null = null;
	/** Only a browser can be sent to an address. */
	readonly openUrl: JevSurface["openUrl"];

	constructor(
		binaryPath: string,
		private readonly appName: string,
	) {
		this.driver = new CuaDriverClient(binaryPath);
		this.openUrl = BROWSERS.test(appName)
			? (url, signal) => this.navigate(url, signal)
			: undefined;
	}

	async observe(signal: AbortSignal): Promise<JevObservation> {
		let window = await this.targetWindow(signal);
		let state = await this.windowState(window, signal);
		// An app owns helper windows with no accessibility tree (Safari in full
		// screen puts a toolbar strip above the real window). Until one window has
		// worked, a dead one just means "try the next".
		while (!this.windowResolved && (state.elements ?? []).length === 0) {
			const next = this.fallbackWindows.shift();
			if (!next) break;
			window = next;
			this.window = next;
			state = await this.windowState(next, signal);
		}
		this.windowResolved ||= (state.elements ?? []).length > 0;
		const rowLabels = rowLabelsFromText(state.elements ?? []);
		const chrome: JevElement[] = [];
		const page: JevElement[] = [];
		const lines: string[] = [];
		for (const element of state.elements ?? []) {
			if (!element.element_token || !element.role) continue;
			if (READABLE.test(element.role) && element.label) {
				lines.push(element.label);
			}
			if (element.enabled === false || NOT_A_CONTROL.test(element.role))
				continue;
			(element.in_web_content ? page : chrome).push({
				handle: element.element_token,
				role: element.role,
				label:
					element.label ??
					(element.element_index === undefined
						? undefined
						: rowLabels.get(element.element_index)),
				value: element.value,
				selected: element.selected === true,
			});
		}
		// The app's own controls (address bar, tabs, toolbar) go first: they sit
		// above the page, and a link-heavy page must not crowd them out.
		const elements = [...chrome, ...page];
		if ((state.elements ?? []).length === 0) {
			// Without the grant the driver reports an unresolved window rather than
			// a permission error, so ask it directly. Otherwise an empty tree is
			// returned as-is: Chromium apps build theirs lazily, and the agent waits.
			const { accessibility } = await this.call<{ accessibility?: boolean }>(
				"check_permissions",
				{},
				signal,
			);
			if (accessibility === false) {
				throw new Error(
					"Backboard Studio needs Accessibility access to operate apps. Enable it in System Settings > Privacy & Security > Accessibility, then relaunch.",
				);
			}
		}
		this.lastElements = elements;
		return {
			appName: window.app_name,
			windowTitle: window.title,
			elements,
			text: visibleText(lines),
		};
	}

	async press(element: JevElement, signal: AbortSignal): Promise<void> {
		const window = await this.targetWindow(signal);
		await this.call(
			"click",
			{ pid: window.pid, element_token: element.handle },
			signal,
		);
	}

	async type(
		element: JevElement,
		text: string,
		signal: AbortSignal,
	): Promise<void> {
		const window = await this.targetWindow(signal);
		// A text field is written to, never pressed: it has no press action, and
		// the driver refused one on Safari's address bar.
		await this.call(
			"type_text",
			{ pid: window.pid, element_token: element.handle, text },
			signal,
		);
		this.lastTyped = { role: element.role, label: element.label };
	}

	async key(key: JevKey, signal: AbortSignal): Promise<void> {
		const window = await this.targetWindow(signal);
		// Return goes to the field that was typed into, not wherever focus is. Its
		// token is looked up again because every new snapshot retires the old ones.
		const typed = this.lastTyped;
		const field =
			key === "return" && typed
				? this.lastElements.find(
						(element) =>
							element.role === typed.role && element.label === typed.label,
					)
				: undefined;
		await this.call(
			"press_key",
			{
				pid: window.pid,
				key,
				...(field ? { element_token: field.handle } : {}),
			},
			signal,
		);
	}

	async scroll(direction: "up" | "down", signal: AbortSignal): Promise<void> {
		const window = await this.targetWindow(signal);
		await this.call(
			"scroll",
			{ pid: window.pid, window_id: window.window_id, direction, by: "page" },
			signal,
		);
	}

	/** Opens the address in the browser without bringing it to the front. */
	private async navigate(url: string, signal: AbortSignal): Promise<void> {
		await this.call(
			"launch_app",
			{ ...(await this.launchTarget(signal)), urls: [url] },
			signal,
		);
	}

	/**
	 * People and models say "Brave"; macOS knows "Brave Browser". An exact name
	 * is tried as given. Anything else is matched against the installed apps, and
	 * launched by bundle id so the match cannot drift.
	 */
	private async launchTarget(
		signal: AbortSignal,
	): Promise<{ name: string } | { bundle_id: string }> {
		if (this.launchBy) return this.launchBy;
		// Listing every installed app takes seconds, so the name is tried as
		// given first and the list is only consulted when macOS does not know it.
		const asGiven = await this.driver.tryCall(
			"launch_app",
			{ name: this.appName },
			signal,
		);
		if (asGiven.ok) return this.remember({ name: this.appName });
		const { apps = [] } = await this.call<{ apps?: DriverApp[] }>(
			"list_apps",
			{},
			signal,
		);
		const match = resolveAppName(this.appName, apps);
		if (!match) {
			const close = apps
				.filter((app) => app.running)
				.map((app) => app.name)
				.slice(0, 12)
				.join(", ");
			throw new Error(
				`No installed app matches "${this.appName}". Running apps: ${close}.`,
			);
		}
		return this.remember(
			match.bundle_id ? { bundle_id: match.bundle_id } : { name: match.name },
		);
	}

	private remember<T extends { name: string } | { bundle_id: string }>(
		target: T,
	): T {
		this.launchBy = target;
		return target;
	}

	async dispose(): Promise<void> {
		await this.driver.close();
	}

	private async targetWindow(signal: AbortSignal): Promise<DriverWindow> {
		if (this.window) return this.window;
		// Launches in the background, or returns the running instance.
		const { pid } = await this.call<{ pid?: number }>(
			"launch_app",
			await this.launchTarget(signal),
			signal,
		);
		// Document windows are titled and large; overlays and strips are neither.
		const area = (window: DriverWindow) =>
			(window.bounds?.width ?? 0) * (window.bounds?.height ?? 0);
		let usable: DriverWindow[] = [];
		// A freshly launched app returns its pid before its window exists.
		for (let attempt = 0; attempt < WINDOW_WAIT_ATTEMPTS; attempt++) {
			const { windows = [] } = await this.call<{ windows?: DriverWindow[] }>(
				"list_windows",
				{},
				signal,
			);
			const owned = windows
				.filter((window) => window.pid === pid)
				.filter((window) => (window.bounds?.height ?? 0) > 60);
			usable = owned.filter((window) => window.is_on_screen !== false);
			if (usable.length > 0) break;
			// macOS hides the accessibility tree of a window on another Space, which
			// is where a full-screen app lives. Waiting will not change that.
			if (owned.some((window) => window.title?.trim())) {
				throw new Error(
					`${this.appName} is on another Space (for example full screen), where macOS hides its controls. Bring it forward with {"action":"openApp","appName":"${this.appName}"}, then run the task again.`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, WINDOW_WAIT_MS));
			if (signal.aborted) throw new Error("aborted");
		}
		const [window, ...rest] = usable.sort(
			(a, b) =>
				Number(!!b.title?.trim()) - Number(!!a.title?.trim()) ||
				area(b) - area(a),
		);
		if (!window) {
			throw new Error(`${this.appName} has no open window to act on.`);
		}
		this.window = window;
		this.fallbackWindows = rest;
		return window;
	}

	private windowState(window: DriverWindow, signal: AbortSignal) {
		return this.call<{
			elements?: DriverElement[];
			degraded_reason?: string | null;
		}>(
			"get_window_state",
			{
				pid: window.pid,
				window_id: window.window_id,
				include_screenshot: false,
				max_elements: MAX_ELEMENTS,
			},
			signal,
		);
	}

	private call<T>(
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<T> {
		return this.driver.call<T>(name, args, signal);
	}
}

/**
 * A sidebar entry is an unlabelled row around a text node ("Bluetooth"). The
 * text is not pressable but the row is, so the row borrows the text's label.
 */
function rowLabelsFromText(
	elements: readonly DriverElement[],
): Map<number, string> {
	const byIndex = new Map<number, DriverElement>();
	for (const element of elements) {
		if (element.element_index !== undefined) {
			byIndex.set(element.element_index, element);
		}
	}
	const labels = new Map<number, string>();
	for (const element of elements) {
		if (element.role !== "AXStaticText" || !element.label?.trim()) continue;
		let parent = byIndex.get(element.parent_index ?? -1);
		// A cell may sit between the text and its row.
		for (let depth = 0; parent && depth < 2; depth++) {
			const index = parent.element_index;
			if (
				index !== undefined &&
				ROW_ROLES.test(parent.role ?? "") &&
				!parent.label &&
				!labels.has(index)
			) {
				labels.set(index, element.label);
				break;
			}
			parent = byIndex.get(parent.parent_index ?? -1);
		}
	}
	return labels;
}
