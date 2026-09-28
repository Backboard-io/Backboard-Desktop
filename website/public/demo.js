// Deterministic, local-only walkthrough of the desktop UI. No live agent calls.
const demoModes = ["simple", "editor", "advanced"];
const sceneDescriptions = {
  simple: "Start a conversation. Let your agent work. Review what changed.",
  editor:
    "Your familiar editor, with agents alongside. Try the files, search, terminal, and chat.",
  advanced:
    "Give each task its own session. Follow your agents from a single board.",
};
const titlebar = (title, extra = "") =>
  `<div class="ide-titlebar"><span>← &nbsp; ▱ &nbsp; ${title}</span><span>${extra || "☷ &nbsp; ▣ &nbsp; ◧"}</span></div>`;
const scenes = {
  simple: `${titlebar("Build the settings page")}
    <div class="ide-conversation">
      <div class="ide-user-message demo-step" data-at="300">Build a settings page that feels like the rest of the app.</div>
      <div class="ide-response demo-step" data-at="1300"><span class="ide-worked">✳ &nbsp; Working</span><p>I’ll use the existing components and keep everything<br class="wide-only"> consistent with your workspace.</p></div>
      <div class="ide-tool-result demo-step" data-at="2700"><span>⌕ &nbsp; Explored 3 files</span><small>settings.tsx · theme.css · panel.tsx</small></div>
      <div class="ide-tool-result demo-step" data-at="3800"><span>✓ &nbsp; Updated settings.tsx</span><small class="diff-add">+84 &nbsp; <span class="diff-remove">−12</span></small></div>
      <div class="ide-response demo-step" data-at="4900"><p>The settings page is ready. Theme controls, notifications,<br class="wide-only"> and workspace preferences are all in place.</p><span class="ide-worked">✓ &nbsp; Ready for review</span></div>
    </div>
    <div class="ide-input-wrap"><div class="ide-changes demo-step" data-at="4900">› &nbsp; 2 files changed <span class="diff-add">+96</span> <span class="diff-remove">−12</span></div><div class="ide-composer"><span>What would you like to build next?</span><div><span>＋ &nbsp; ♧</span><span>Backboard &nbsp; · &nbsp; Medium &nbsp;⌄ &nbsp; <span class="ide-send">↑</span></span></div></div><div class="ide-input-footer">▣ &nbsp; Local &nbsp;&nbsp; ▱ &nbsp; orbit</div></div>`,
  editor: `${titlebar("orbit — settings.tsx", "⑂ feat/settings &nbsp; ◧")}
    <div class="ide-editor-layout"><div class="ide-file-tree"><span>EXPLORER</span><p>⌄ &nbsp; orbit</p><p>&nbsp; ⌄ &nbsp; src</p><p>&nbsp; &nbsp; ▱ components</p><p class="file-selected">&nbsp; &nbsp; settings.tsx</p><p>&nbsp; &nbsp; theme.css</p><p>&nbsp; ▱ tests</p><p>&nbsp; package.json</p></div><div class="ide-editor-main"><div class="ide-file-tabs"><span>settings.tsx &nbsp; ×</span><span>theme.css</span></div><div class="ide-code"><div><i>1</i><code><b>import</b> { Panel, Toggle } <b>from</b> <em>'./components'</em>;</code></div><div><i>2</i><code></code></div><div><i>3</i><code><b>export function</b> <strong>Settings</strong>() {</code></div><div><i>4</i><code>  <b>return</b> (</code></div><div><i>5</i><code>    &lt;<strong>Panel</strong> title=<em>"Your workspace"</em>&gt;</code></div><div class="demo-step code-added" data-at="800"><i>6</i><code>      &lt;<strong>ThemePicker</strong> /&gt;</code></div><div class="demo-step code-added" data-at="1600"><i>7</i><code>      &lt;<strong>Toggle</strong> label=<em>"Notifications"</em> /&gt;</code></div><div class="demo-step code-added" data-at="2400"><i>8</i><code>      &lt;<strong>WorkspacePreferences</strong> /&gt;</code></div><div><i>9</i><code>    &lt;/<strong>Panel</strong>&gt;</code></div><div><i>10</i><code>  );</code></div><div><i>11</i><code>}</code></div></div><div class="ide-terminal"><div>TERMINAL &nbsp;&nbsp; PROBLEMS &nbsp;&nbsp; OUTPUT</div><p>❯ bun test settings</p><p class="demo-step diff-add" data-at="3500">✓ theme preferences<br>✓ notification settings<br>✓ workspace defaults</p><p class="demo-step" data-at="4700">3 passed &nbsp; · &nbsp; 0 failed</p></div></div><aside class="ide-review"><span>CHANGES</span><h4>Settings page</h4><p>2 files changed</p><div class="demo-step review-file" data-at="1200">settings.tsx <span class="diff-add">+84</span></div><div class="demo-step review-file" data-at="2400">theme.css <span class="diff-add">+12</span></div><div class="demo-step review-ready" data-at="4700">✓ Ready for your review</div></aside></div><div class="ide-editor-status">⑂ feat/settings <span>TypeScript React &nbsp; UTF-8</span></div>`,
  advanced: `${titlebar('<span class="board-view">Board</span> <span class="board-view muted">Kanban</span> &nbsp; ＋ Add filters', "3 agents &nbsp; ◧")}
    <div class="ide-agent-board"><article class="ide-agent-card"><header><span>Build the settings page</span><small>DONE</small></header><div class="agent-transcript"><p>Using the existing components<br>and workspace theme.</p><p class="demo-step" data-at="700">✓ Updated settings.tsx<br>✓ Updated theme.css</p><p class="demo-step" data-at="1900">The settings page is ready<br>for your review.</p><div class="agent-diff demo-step" data-at="2900"><span>2 files changed</span><b>+96 −12</b></div></div><footer>▱ orbit <span>just now</span></footer></article><article class="ide-agent-card"><header><span>Add keyboard shortcuts</span><small class="agent-running">WORKING</small></header><div class="agent-transcript"><p>Checking the command registry<br>and existing key bindings.</p><p class="demo-step" data-at="1600">⌕ Explored 4 files</p><p class="demo-step" data-at="3300">Adding shortcuts for navigation<br>and the command palette.</p><div class="agent-diff demo-step" data-at="4600"><span>1 file changed</span><b>+28 −2</b></div></div><footer>▱ orbit <span>just now</span></footer></article><article class="ide-agent-card"><header><span>Review the navigation</span><small>DONE</small></header><div class="agent-transcript"><p>Reviewing focus order and<br>keyboard access.</p><p class="demo-step" data-at="1200">✓ Checked 6 components</p><p class="demo-step" data-at="2700">All navigation items are<br>reachable with the keyboard.</p><div class="agent-diff demo-step" data-at="4000"><span>Review complete</span><b>✓</b></div></div><footer>▱ orbit <span>just now</span></footer></article></div><div class="ide-board-caption">Every session has its own context. You keep the whole picture.</div>`,
};

// Match the real Advanced board's nine-card density, with fictitious work.
const extraSessions = [
  [
    "Write the onboarding flow",
    "WORKING",
    "Building the first-run experience.",
    "Reading welcome.tsx and routes.ts.",
  ],
  [
    "Add a command palette",
    "DONE",
    "Keyboard navigation is in place.",
    "Search, select, and run any command.",
  ],
  [
    "Refine the theme controls",
    "DONE",
    "Light and dark themes are ready.",
    "Preferences persist across sessions.",
  ],
  [
    "Test the workspace picker",
    "DONE",
    "Checked switching between projects.",
    "All workspace tests passed.",
  ],
  [
    "Update the documentation",
    "WORKING",
    "Documenting the new settings.",
    "Adding examples to the setup guide.",
  ],
  [
    "Review the latest changes",
    "DONE",
    "Reviewed the implementation.",
    "Ready for your final review.",
  ],
];
scenes.advanced = scenes.advanced.replace(
  '</div><div class="ide-board-caption">',
  extraSessions
    .map(
      ([title, status, line1, line2], index) =>
        `<article class="ide-agent-card"><header><span>✓ &nbsp; ${title}</span><small>${status}</small><span class="card-close" aria-hidden="true">×</span></header><div class="agent-transcript"><p>${line1}</p><p class="demo-step" data-at="${700 + index * 500}">${line2}</p></div><footer>▱ orbit <span>${index + 2}m ago</span></footer></article>`,
    )
    .join("") + '</div><div class="ide-board-caption">',
);
scenes.advanced = scenes.advanced
  .replace("3 agents", "Page 1 of 1 · 9 agents")
  .replace("← &nbsp; ▱ &nbsp; ", "");
scenes.simple = scenes.simple
  .replace(
    "Backboard &nbsp; · &nbsp; Medium &nbsp;⌄",
    "DeepSeek V4 Flash &nbsp; · &nbsp; Medium &nbsp;⌄",
  )
  .replace(
    "What would you like to build next?",
    "Tip: Type @ conversation to bring in context from another chat",
  );
const uiGlyphs = {
  "←": "ea9b",
  "▱": "eaf7",
  "☷": "eb52",
  "▣": "ea85",
  "◧": "ebf4",
  "⌕": "ea6d",
  "✓": "eab2",
  "＋": "ea60",
  "♧": "eb2d",
  "↑": "eaa1",
  "⌄": "eab4",
};
for (const mode of demoModes) {
  scenes[mode] = scenes[mode].replaceAll(
    "<footer>▱ orbit <span>",
    "<footer><span>▱ orbit</span><span>",
  );
  for (const [glyph, code] of Object.entries(uiGlyphs)) {
    scenes[mode] = scenes[mode].replaceAll(
      glyph,
      `<i class="ide-icon" aria-hidden="true">&#x${code};</i>`,
    );
  }
}

scenes.editor = EditorDemo.markup();

const panel = document.querySelector("#mode-panel");
const scene = document.querySelector("#ide-scene");
const demoTabs = [...document.querySelectorAll("[data-mode]")];
const play = document.querySelector("#demo-play");
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
const duration = 6000;
let currentMode = "simple";
let elapsed = 0;
let playing = !motionPreference.matches;
let inView = false;
let previousTime = null;
let frame = null;
let steps = [];

function drawProgress() {
  steps.forEach((step) =>
    step.classList.toggle("revealed", elapsed >= Number(step.dataset.at) * 0.8),
  );
  const index = demoModes.indexOf(currentMode);
  document.querySelector(".demo-timeline span").style.width =
    `${((index + elapsed / duration) / demoModes.length) * 100}%`;
}

function renderMode(mode, { manual = false, focus = false } = {}) {
  if (!demoModes.includes(mode)) return;
  currentMode = mode;
  // Manual browsing shows the complete scene; Replay starts the choreography.
  elapsed = manual || (motionPreference.matches && !playing) ? duration : 0;
  if (manual) playing = false;
  panel.dataset.mode = mode;
  panel.setAttribute("aria-labelledby", `tab-${mode}`);
  demoTabs.forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  });
  document
    .querySelectorAll("[data-mini-mode]")
    .forEach((pill) =>
      pill.classList.toggle("active", pill.dataset.miniMode === mode),
    );
  scene.innerHTML = scenes[mode];
  if (mode === "editor") EditorDemo.bind(scene);
  steps = [...scene.querySelectorAll("[data-at]")];
  document.querySelector("#mode-description").textContent =
    sceneDescriptions[mode];
  document.querySelector("#demo-chapter").textContent =
    `0${demoModes.indexOf(mode) + 1} / 03 · ${mode[0].toUpperCase()}${mode.slice(1)}`;
  drawProgress();
  syncPlayback();
}

function tick(time) {
  frame = null;
  if (!playing || !inView || document.hidden) {
    previousTime = null;
    return;
  }
  if (previousTime !== null) elapsed += Math.min(time - previousTime, 100);
  previousTime = time;
  if (elapsed >= duration) {
    renderMode(
      demoModes[(demoModes.indexOf(currentMode) + 1) % demoModes.length],
    );
  } else drawProgress();
  if (frame === null) frame = requestAnimationFrame(tick);
}

function syncPlayback() {
  play.innerHTML = playing ? "Ⅱ <span>Pause</span>" : "▷ <span>Play</span>";
  play.setAttribute(
    "aria-label",
    playing ? "Pause walkthrough" : "Play walkthrough",
  );
  panel.classList.toggle("demo-playing", playing && inView && !document.hidden);
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  previousTime = null;
  if (playing && inView && !document.hidden)
    frame = requestAnimationFrame(tick);
}

demoTabs.forEach((tab, index) => {
  tab.addEventListener("click", () =>
    renderMode(tab.dataset.mode, { manual: true }),
  );
  tab.addEventListener("keydown", (event) => {
    const next = {
      ArrowRight: (index + 1) % 3,
      ArrowLeft: (index + 2) % 3,
      Home: 0,
      End: 2,
    }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      renderMode(demoModes[next], { manual: true, focus: true });
    }
  });
});
document
  .querySelectorAll("[data-show-mode]")
  .forEach((link) =>
    link.addEventListener("click", () =>
      renderMode(link.dataset.showMode, { manual: true, focus: true }),
    ),
  );
play.addEventListener("click", () => {
  playing = !playing;
  if (playing && elapsed >= duration) elapsed = 0;
  drawProgress();
  syncPlayback();
});
document.querySelector("#demo-replay").addEventListener("click", () => {
  playing = true;
  renderMode("simple");
  // An explicit replay is permitted with reduced motion, without CSS transitions.
  elapsed = 0;
  drawProgress();
});
panel.addEventListener("focusin", () => {
  playing = false;
  syncPlayback();
});
new IntersectionObserver(
  ([entry]) => {
    inView = entry.isIntersecting;
    syncPlayback();
  },
  { threshold: 0.2 },
).observe(panel);
document.addEventListener("visibilitychange", syncPlayback);
motionPreference.addEventListener("change", () => {
  if (motionPreference.matches) {
    playing = false;
    elapsed = duration;
    drawProgress();
    syncPlayback();
  }
});
renderMode("simple");

scene.addEventListener("click", (event) => {
  const mode = event.target.closest("[data-inline-mode]")?.dataset.inlineMode;
  if (mode) renderMode(mode, { manual: true });
});

document
  .querySelectorAll("[data-mini-mode]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      renderMode(button.dataset.miniMode, { manual: true }),
    ),
  );
