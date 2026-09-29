// Content for the interactive Backboard Desktop replica. Everything here is
// illustrative: a small surf-report project the demo agent "works on".

export type ToolKind = "read" | "edit" | "create" | "run" | "search";
export type Tool = { k: ToolKind; path: string; add?: number; del?: number; note?: string };
export type DiffLine = [" " | "+" | "-", string];

export type Site = {
  theme: "light" | "dark";
  accent: string;
  chart: boolean;
  tides: boolean;
  extras: string[];
};

export const INITIAL_SITE: Site = { theme: "light", accent: "#1f8fb5", chart: false, tides: false, extras: [] };

export type Script = {
  id: string;
  match: RegExp;
  tools: Tool[];
  reply: string;
  effect: (site: Site, prompt: string) => Site;
  diff: { file: string; lines: DiffLine[] };
  term: string[];
};

export const SCRIPTS: Script[] = [
  {
    id: "chart",
    match: /chart|swell|forecast|graph|week|5.day/i,
    tools: [
      { k: "search", path: "swell", note: "3 results" },
      { k: "read", path: "src/forecast.ts" },
      { k: "create", path: "src/components/SwellChart.tsx", add: 38 },
      { k: "edit", path: "src/App.tsx", add: 4, del: 1 },
      { k: "run", path: "npm test", note: "14 passed" },
    ],
    reply:
      "Added a 5-day swell chart under the hero. Each bar is the peak wave height for the day, and the best day gets a little `go surf` flag. It reads straight from `forecast()` so it updates with the report.",
    effect: (s) => ({ ...s, chart: true }),
    diff: {
      file: "src/App.tsx",
      lines: [
        [" ", 'import { Hero } from "./components/Hero";'],
        ["+", 'import { SwellChart } from "./components/SwellChart";'],
        [" ", 'import { forecast } from "./forecast";'],
        [" ", ""],
        [" ", "export default function App() {"],
        [" ", '  const days = forecast("montauk");'],
        [" ", "  return ("],
        [" ", "    <main>"],
        [" ", "      <Hero today={days[0]} />"],
        ["-", "      <p className=\"soon\">More soon</p>"],
        ["+", "      <SwellChart days={days} />"],
        ["+", "      {/* best day gets the flag */}"],
        ["+", "      <BestDay days={days} />"],
        [" ", "    </main>"],
        [" ", "  );"],
        [" ", "}"],
      ],
    },
    term: ["$ npm test", " ✓ forecast › maps swell to feet (3 ms)", " ✓ SwellChart › renders five bars", " Tests  14 passed (14)", ""],
  },
  {
    id: "dark",
    match: /dark|night|theme|black/i,
    tools: [
      { k: "read", path: "src/styles.css" },
      { k: "edit", path: "src/styles.css", add: 22, del: 6 },
      { k: "edit", path: "src/App.tsx", add: 3, del: 1 },
      { k: "run", path: "npm run build", note: "built in 412ms" },
    ],
    reply:
      "Dark mode is in. The page follows the system setting, the sea colours stay bright so the report still pops at night, and there's a toggle in the header if you want to flip it by hand.",
    effect: (s) => ({ ...s, theme: s.theme === "dark" ? "light" : "dark" }),
    diff: {
      file: "src/styles.css",
      lines: [
        [" ", ":root {"],
        ["-", "  --bg: #fffaf0;"],
        ["-", "  --ink: #10222b;"],
        ["+", "  --bg: light-dark(#fffaf0, #0b1820);"],
        ["+", "  --ink: light-dark(#10222b, #e9f4f7);"],
        ["+", "  color-scheme: light dark;"],
        [" ", "  --sea: #1f8fb5;"],
        [" ", "}"],
        [" ", ""],
        ["+", "[data-theme=\"dark\"] {"],
        ["+", "  color-scheme: dark;"],
        ["+", "}"],
      ],
    },
    term: ["$ npm run build", " vite v7.1 building for production…", " ✓ 42 modules transformed.", " dist/index.html  0.46 kB", " ✓ built in 412ms", ""],
  },
  {
    id: "sunset",
    match: /sunset|orange|colou?r|warm|palette|paint/i,
    tools: [
      { k: "read", path: "src/styles.css" },
      { k: "edit", path: "src/styles.css", add: 6, del: 4 },
      { k: "run", path: "npm run lint", note: "no problems" },
    ],
    reply:
      "Repainted it in sunset orange. The accent, buttons and chart bars all come from one `--sea` token now, so the whole page shifts together.",
    effect: (s) => ({ ...s, accent: s.accent === "#ff6b2c" ? "#1f8fb5" : "#ff6b2c" }),
    diff: {
      file: "src/styles.css",
      lines: [
        [" ", ":root {"],
        [" ", "  --bg: #fffaf0;"],
        [" ", "  --ink: #10222b;"],
        ["-", "  --sea: #1f8fb5;"],
        ["-", "  --foam: #d9f1f6;"],
        ["+", "  --sea: #ff6b2c;"],
        ["+", "  --foam: #ffe6d6;"],
        [" ", "}"],
      ],
    },
    term: ["$ npm run lint", " eslint src --max-warnings 0", " ✓ no problems", ""],
  },
  {
    id: "tides",
    match: /tide|table|moon/i,
    tools: [
      { k: "read", path: "src/forecast.ts" },
      { k: "create", path: "src/components/TideTable.tsx", add: 29 },
      { k: "edit", path: "src/App.tsx", add: 2 },
      { k: "run", path: "npm test", note: "16 passed" },
    ],
    reply:
      "Added today's tide table: highs and lows with times, and the next change highlighted. It sits beside the chart on wide screens and stacks on a phone.",
    effect: (s) => ({ ...s, tides: true }),
    diff: {
      file: "src/components/TideTable.tsx",
      lines: [
        ["+", "export function TideTable({ tides }: { tides: Tide[] }) {"],
        ["+", "  return ("],
        ["+", "    <table className=\"tides\">"],
        ["+", "      {tides.map((t) => ("],
        ["+", "        <tr key={t.time}>"],
        ["+", "          <td>{t.kind}</td><td>{t.time}</td><td>{t.ft} ft</td>"],
        ["+", "        </tr>"],
        ["+", "      ))}"],
        ["+", "    </table>"],
        ["+", "  );"],
        ["+", "}"],
      ],
    },
    term: ["$ npm test", " ✓ TideTable › highlights the next change", " Tests  16 passed (16)", ""],
  },
];

export const FALLBACK: Script = {
  id: "any",
  match: /./,
  tools: [
    { k: "search", path: "components", note: "6 results" },
    { k: "read", path: "src/App.tsx" },
    { k: "create", path: "src/components/Section.tsx", add: 24 },
    { k: "edit", path: "src/App.tsx", add: 3 },
    { k: "run", path: "npm run build", note: "built in 388ms" },
  ],
  reply: "Done. I added it as its own section below the report so it's easy to move around, and checked the build.",
  effect: (s, prompt) => ({ ...s, extras: [...s.extras, prompt].slice(-2) }),
  diff: {
    file: "src/App.tsx",
    lines: [
      [" ", "      <Hero today={days[0]} />"],
      ["+", "      <Section title={idea.title}>"],
      ["+", "        {idea.body}"],
      ["+", "      </Section>"],
      [" ", "    </main>"],
    ],
  },
  term: ["$ npm run build", " ✓ 44 modules transformed.", " ✓ built in 388ms", ""],
};

export function pickScript(prompt: string) {
  return SCRIPTS.find((s) => s.match.test(prompt)) ?? FALLBACK;
}

export const SUGGESTIONS = ["Add a 5-day swell chart", "Paint it sunset orange", "Make it dark mode", "Add a tide table"];

export const AUTOPLAY_PROMPT = "Add a 5-day swell chart";

export type Msg =
  | { id: string; role: "user"; text: string }
  | {
      id: string;
      role: "agent";
      script: string;
      prompt: string;
      tools: Tool[];
      reply: string;
      secs: number;
      /** Progress; a finished message has everything shown. */
      stage: "thinking" | "tools" | "text" | "done";
      shownTools: number;
      shownWords: number;
    };

export type Session = { id: string; title: string; folder: string; msgs: Msg[]; ago: string };

const done = (id: string, prompt: string, tools: Tool[], reply: string, secs = 6): Msg => ({
  id,
  role: "agent",
  script: "static",
  prompt,
  tools,
  reply,
  secs,
  stage: "done",
  shownTools: tools.length,
  shownWords: 1e6,
});

export const SESSIONS: Session[] = [
  {
    id: "s1",
    folder: "surf-report",
    title: "Build a surf report for Montauk",
    ago: "now",
    msgs: [
      { id: "m1", role: "user", text: "Build a surf report site for Montauk. Sunny, loud, fun." },
      done(
        "m2",
        "",
        [
          { k: "create", path: "index.html", add: 18 },
          { k: "create", path: "src/App.tsx", add: 31 },
          { k: "create", path: "src/forecast.ts", add: 44 },
          { k: "create", path: "src/styles.css", add: 96 },
          { k: "run", path: "npm run dev", note: "ready on :5173" },
        ],
        "Your surf report is live in the preview. Today's call is up top in big type, with wind, water temp and the best window to paddle out. Want a swell chart next?",
        14,
      ),
    ],
  },
  {
    id: "s2",
    folder: "surf-report",
    title: "Swell chart looks off on mobile",
    ago: "2h",
    msgs: [
      { id: "a1", role: "user", text: "the swell chart bars overflow on my phone" },
      done(
        "a2",
        "",
        [
          { k: "read", path: "src/components/SwellChart.tsx" },
          { k: "edit", path: "src/components/SwellChart.tsx", add: 5, del: 3 },
          { k: "run", path: "npm test", note: "14 passed" },
        ],
        "Fixed. The bars now use `flex: 1` with a `min-width: 0`, so they share the row instead of pushing past it. Checked at 320px wide.",
        5,
      ),
    ],
  },
  {
    id: "s3",
    folder: "surf-report",
    title: "Wire up the buoy API",
    ago: "1d",
    msgs: [
      { id: "b1", role: "user", text: "pull real swell data from the NDBC buoy 44017" },
      done(
        "b2",
        "",
        [
          { k: "search", path: "fetch", note: "2 results" },
          { k: "edit", path: "src/forecast.ts", add: 27, del: 9 },
          { k: "create", path: "src/buoy.ts", add: 41 },
          { k: "run", path: "npm test", note: "12 passed" },
        ],
        "`forecast()` now reads the latest buoy report, converts metres to feet and caches it for ten minutes. If the buoy is offline it falls back to the last good reading.",
        11,
      ),
    ],
  },
  {
    id: "s4",
    folder: "backboard-site",
    title: "Hero copy pass",
    ago: "3d",
    msgs: [
      { id: "c1", role: "user", text: "tighten the hero copy, less words" },
      done(
        "c2",
        "",
        [
          { k: "read", path: "app/page.tsx" },
          { k: "edit", path: "app/page.tsx", add: 2, del: 7 },
        ],
        "Cut it to one line: **Good ideas come in waves.** The download buttons do the rest.",
        4,
      ),
    ],
  },
  {
    id: "s5",
    folder: "backboard-site",
    title: "Paint a Bronkhorst-style wave",
    ago: "4d",
    msgs: [
      { id: "d1", role: "user", text: "make me an image of a werner bronkhorst style wave with tiny surfers" },
      done(
        "d2",
        "",
        [{ k: "create", path: "wave-ribbon.png", note: "image" }],
        "Done: a long ribbon of palette-knife turquoise with two tiny surfers on coral boards. It's open in Canvas if you want to tweak it.",
        22,
      ),
    ],
  },
];

export const MODELS = [
  { name: "Claude Opus", icon: "/assets/providers/ai_claude.svg", note: "Best for big changes" },
  { name: "GPT", icon: "/assets/providers/ai_open_ai.svg", note: "Fast and sharp" },
  { name: "Gemini Pro", icon: "/assets/providers/ai_gemini.svg", note: "Huge context" },
  { name: "DeepSeek", icon: "/assets/providers/ai_deep_seek.svg", note: "Great value" },
  { name: "Grok", icon: "/assets/providers/ai_x_ai.svg", note: "" },
  { name: "Kimi", icon: "/assets/providers/brand_kimi-color.svg", note: "" },
  { name: "Qwen", icon: "/assets/providers/brand_qwen-color.svg", note: "" },
  { name: "Ollama", icon: "/assets/providers/ai_ollama.svg", note: "Runs on your Mac" },
];

export const CONNECTORS = [
  { name: "GitHub", note: "Issues, PRs and repos", on: true },
  { name: "Linear", note: "Tickets and projects", on: true },
  { name: "Figma", note: "Frames and components", on: false },
  { name: "Postgres", note: "Query your database", on: false },
  { name: "Sentry", note: "Errors and traces", on: true },
  { name: "Slack", note: "Channels and threads", on: false },
];

export const CANVAS = [
  "/assets/tiles/ribbon.webp",
  "/assets/tiles/lineup.webp",
  "/assets/tiles/reef.webp",
  "/assets/tiles/shore.webp",
  "/assets/tiles/wave.webp",
  "/assets/tiles/solar.webp",
  "/assets/tiles/afterglow.webp",
  "/assets/tiles/sun.webp",
];

// ---- Editor mode ----

export type FileNode = { name: string; path?: string; children?: FileNode[]; git?: "M" | "U" };

export const TREE: FileNode[] = [
  { name: ".github", children: [{ name: "workflows", children: [{ name: "deploy.yml", path: ".github/workflows/deploy.yml" }] }] },
  { name: "public", children: [{ name: "hero.webp", path: "public/hero.webp" }] },
  {
    name: "src",
    children: [
      {
        name: "components",
        children: [
          { name: "Hero.tsx", path: "src/components/Hero.tsx" },
          { name: "SwellChart.tsx", path: "src/components/SwellChart.tsx", git: "U" },
        ],
      },
      { name: "App.tsx", path: "src/App.tsx", git: "M" },
      { name: "forecast.ts", path: "src/forecast.ts" },
      { name: "styles.css", path: "src/styles.css", git: "M" },
    ],
  },
  { name: "package.json", path: "package.json" },
  { name: "README.md", path: "README.md" },
];

export const FILES: Record<string, string> = {
  "src/App.tsx": `import { Hero } from "./components/Hero";
import { SwellChart } from "./components/SwellChart";
import { forecast } from "./forecast";
import "./styles.css";

// Montauk surf report. One page, loud and sunny.
export default function App() {
  const days = forecast("montauk");
  const best = days.reduce((a, b) => (b.ft > a.ft ? b : a));

  return (
    <main className="report">
      <Hero today={days[0]} />
      <SwellChart days={days} best={best.label} />
      <footer>
        Updated every 10 minutes from buoy 44017.
      </footer>
    </main>
  );
}
`,
  "src/forecast.ts": `export type Day = { label: string; ft: number; wind: string; sun: number };

const SPOTS = { montauk: "44017", rockaway: "44065" } as const;

// Latest buoy reading, converted to a friendly forecast.
export async function forecast(spot: keyof typeof SPOTS) {
  const res = await fetch(\`/api/buoy/\${SPOTS[spot]}\`);
  const swell: { height: number; label: string }[] = await res.json();

  return swell.map((day) => ({
    label: day.label,
    ft: Math.round(day.height * 3.28),
    wind: day.height > 1.4 ? "offshore" : "light",
    sun: 0.8,
  }));
}

export const vibe = (d: Day) => (d.ft >= 4 ? "go surf" : "write code");
`,
  "src/components/Hero.tsx": `import type { Day } from "../forecast";

export function Hero({ today }: { today: Day }) {
  return (
    <header className="hero">
      <p className="kicker">Montauk · Ditch Plains</p>
      <h1>{today.ft}–{today.ft + 1} ft</h1>
      <p>
        Clean, {today.wind} wind. Paddle out before 9.
      </p>
      <img src="/hero.webp" alt="Painted wave with tiny surfers" />
    </header>
  );
}
`,
  "src/components/SwellChart.tsx": `import type { Day } from "../forecast";

export function SwellChart({ days, best }: { days: Day[]; best: string }) {
  const max = Math.max(...days.map((d) => d.ft));

  return (
    <section className="chart" aria-label="5-day swell">
      {days.map((d) => (
        <div key={d.label} className="bar">
          <span style={{ height: \`\${(d.ft / max) * 100}%\` }} />
          <b>{d.label}</b>
          {d.label === best && <em>go surf</em>}
        </div>
      ))}
    </section>
  );
}
`,
  "src/styles.css": `:root {
  --bg: #fffaf0;
  --ink: #10222b;
  --sea: #1f8fb5;
  --foam: #d9f1f6;
  color-scheme: light dark;
}

.hero h1 {
  font: 800 clamp(64px, 12vw, 160px)/0.9 "Instrument Sans";
  color: var(--sea);
}

.chart {
  display: flex;
  gap: 12px;
  height: 180px;
}

.bar span {
  background: var(--sea);
  border-radius: 8px 8px 2px 2px;
}
`,
  "package.json": `{
  "name": "surf-report",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.3.0",
    "react-dom": "^19.3.0"
  },
  "devDependencies": {
    "vite": "^7.1.0",
    "vitest": "^4.0.0"
  }
}
`,
  "README.md": `# Montauk surf report

A tiny, loud, sunny surf report. Built in **Backboard Desktop**.

## Run it

    npm install
    npm run dev

Data comes from NDBC buoy 44017, refreshed every 10 minutes.
`,
  ".github/workflows/deploy.yml": `name: deploy
on:
  push:
    branches: [main]
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: npm ci && npm run build
      - run: npx backboard-apps deploy dist
`,
};

export const TERMINAL_BOOT = [
  "$ npm run dev",
  "",
  "  VITE v7.1.0  ready in 212 ms",
  "",
  "  ➜  Local:   http://localhost:5173/",
  "  ➜  Network: use --host to expose",
  "",
];
