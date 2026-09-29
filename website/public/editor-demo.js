/* A local interactive recreation of Backboard's Code–OSS editor shell. */
const EditorDemo = (() => {
  const icon = (code) =>
    `<i class="ide-icon" aria-hidden="true">&#x${code};</i>`;
  const files = {
    "settings.tsx": `import { useState } from 'react';\nimport { Panel, Toggle } from './components';\nimport './theme.css';\n\nexport function Settings() {\n  const [notifications, setNotifications] = useState(true);\n  const [theme, setTheme] = useState('system');\n\n  return (\n    <Panel title="Your workspace">\n      <section className="settings-section">\n        <h2>Appearance</h2>\n        <ThemePicker\n          value={theme}\n          onChange={setTheme}\n        />\n      </section>\n\n      <section className="settings-section">\n        <h2>Notifications</h2>\n        <Toggle\n          checked={notifications}\n          onChange={setNotifications}\n          label="Agent updates"\n        />\n      </section>\n\n      <WorkspacePreferences />\n    </Panel>\n  );\n}`,
    "theme.css": `:root {\n  color-scheme: dark;\n  --background: #191a1d;\n  --surface: #25262c;\n  --foreground: #d4d4d8;\n  --border: #34353b;\n}\n\n.settings-section {\n  display: grid;\n  gap: 16px;\n  padding: 24px;\n  border-bottom: 1px solid var(--border);\n}\n\n.settings-section h2 {\n  margin: 0;\n  font-size: 14px;\n  font-weight: 500;\n}\n\n@media (prefers-reduced-motion: reduce) {\n  * { scroll-behavior: auto; }\n}`,
    "package.json": `{\n  "name": "orbit-workspace",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "build": "tsc && vite build",\n    "test": "vitest"\n  },\n  "dependencies": {\n    "react": "^19.0.0",\n    "react-dom": "^19.0.0"\n  }\n}`,
    "README.md": `# Orbit workspace\n\nA workspace that feels like home.\n\n## Getting started\n\nInstall dependencies, then start the dev server.\n\n    bun install\n    bun run dev\n\n## Workspace settings\n\n- Choose a light, dark, or system theme.\n- Control agent notifications.\n- Keep project preferences in one place.\n\n## Checks\n\n    bun test\n    bun run build`,
  };
  const esc = (value) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  function code(file) {
    return files[file]
      .split("\n")
      .map((line, i) => {
        const tokens = line.split(
          /('.*?'|".*?"|\b(?:import|from|export|function|const|return|true|false)\b)/g,
        );
        const content = tokens
          .map((token) =>
            /^['"]/.test(token)
              ? `<em>${esc(token)}</em>`
              : /^(import|from|export|function|const|return|true|false)$/.test(
                    token,
                  )
                ? `<b>${token}</b>`
                : esc(token),
          )
          .join("");
        return `<div class="editor-code-line" style="--line:${i}"><span>${i + 1}</span><code>${content || " "}</code></div>`;
      })
      .join("");
  }
  const fileButton = (name) =>
    `<button type="button" data-editor-file="${name}" class="editor-file ${name === "settings.tsx" ? "selected" : ""}"><span class="file-type">${name.endsWith("tsx") ? "TS" : name.endsWith("css") ? "#" : name.endsWith("json") ? "{}" : "ⓘ"}</span>${name}${["settings.tsx", "theme.css"].includes(name) ? "<small>M</small>" : ""}</button>`;
  const tabMarkup = (name) =>
    `<div class="editor-tab" data-tab-name="${name}"><button type="button" data-editor-file="${name}" class="${name === "settings.tsx" ? "selected" : ""}"><span class="file-type">${name.endsWith("tsx") ? "TS" : name.endsWith("css") ? "#" : name.endsWith("json") ? "{}" : "ⓘ"}</span>${name}</button><button type="button" class="editor-tab-close" data-editor-close="${name}" aria-label="Close ${name}">×</button></div>`;
  function markup() {
    return `<div class="editor-shell">
    <div class="editor-windowbar"><div class="editor-mode-switch">${["Simple", "Editor", "Advanced"].map((m) => `<button type="button" data-inline-mode="${m.toLowerCase()}" class="${m === "Editor" ? "selected" : ""}">${m}</button>`).join("")}</div><button type="button" data-editor-action="explorer" aria-label="Toggle explorer">${icon("ebf3")}</button><span class="editor-nav-arrows">${icon("ea9b")} ${icon("ea9c")}</span><div class="editor-command">${icon("ea6d")} orbit</div><button type="button" data-editor-action="terminal" aria-label="Toggle terminal">${icon("ea85")}</button><button type="button" data-editor-action="chat" aria-label="Toggle chat panel">${icon("ebf4")}</button></div>
    <div class="editor-workbench"><div class="editor-activity"><button type="button" class="selected" data-editor-view="files" aria-label="Explorer">${icon("eaf0")}</button><button type="button" data-editor-view="search" aria-label="Search files">${icon("ea6d")}</button><button type="button" data-editor-view="changes" aria-label="Source control">${icon("ea68")}</button><button type="button" data-editor-action="terminal" aria-label="Run and debug">${icon("eb91")}</button><span>${icon("eae6")}</span><span>${icon("eb9c")}</span><div class="activity-spacer"></div><span>${icon("eb51")}</span></div>
    <aside class="editor-explorer"><div class="explorer-heading"><strong id="explorer-title">Explorer</strong><span>···</span></div><div class="editor-search-box" hidden><label>Search files<input type="search" placeholder="File name…" aria-label="Search demo files"></label></div><div class="editor-files"><details open><summary>orbit</summary><details open><summary>src</summary><details><summary>components</summary><span class="file-note">Panel.tsx<br>Toggle.tsx</span></details>${fileButton("settings.tsx")}${fileButton("theme.css")}</details><details><summary>tests</summary><span class="file-note">settings.test.tsx</span></details>${fileButton("package.json")}${fileButton("README.md")}</details></div><div class="editor-outlines"><details><summary>Outline</summary><span>Settings()</span></details><details><summary>Timeline</summary><span>Updated just now</span></details></div></aside>
    <div class="editor-center"><div class="editor-tabs">${["settings.tsx", "theme.css"].map(tabMarkup).join("")}<span class="editor-tab-actions">${icon("eb56")} ···</span></div><div class="editor-breadcrumb">src ${icon("eab6")} <span id="editor-current-file">settings.tsx</span> ${icon("eab6")} <span>Settings</span></div><div class="editor-code-viewport"><div class="editor-code-scroll"><div id="editor-source">${code("settings.tsx")}</div></div><div class="editor-minimap" aria-hidden="true">${Array.from({ length: 30 }, (_, i) => `<i style="width:${20 + ((i * 17) % 70)}%"></i>`).join("")}</div></div><div class="editor-bottom-panel" hidden><div class="editor-panel-tabs">PROBLEMS &nbsp; OUTPUT &nbsp; <strong>TERMINAL</strong><button type="button" data-editor-action="terminal" aria-label="Close terminal">×</button></div><div class="editor-terminal-output">orbit on feat/settings<br><span>❯ bun test</span><br><span class="diff-add">✓ settings.test.tsx (3 tests)</span><br>3 passed · 0 failed<br>❯ <span class="terminal-caret">▋</span></div></div></div>
    <aside class="editor-chat"><div class="editor-chat-tabs"><span>New Chat</span><button type="button" data-editor-action="clear-chat" aria-label="New demo chat">${icon("ea60")}</button><span>${icon("ea82")}</span><button type="button" data-editor-action="chat" aria-label="Hide chat panel">×</button></div><div class="editor-chat-history"><div class="editor-welcome"><img src="assets/studio-mark.svg" alt="" width="84" height="50"><h3>Backboard Desktop</h3><p>What would you like to build?</p></div></div><form class="editor-chat-form"><div class="editor-input-surface"><span class="editor-context">＋ <span class="file-type">TS</span> <span id="editor-context-file">settings.tsx</span></span><textarea aria-label="Demo chat prompt" placeholder="Tip: Type @ conversation to bring in context from another chat" rows="3"></textarea><div class="editor-composer-actions"><span>${icon("ea60")} ${icon("eb2d")}</span><span class="editor-model">DeepSeek V4.1 Flash</span><span>${icon("ec12")}</span><button type="submit" aria-label="Send demo message">${icon("eaa1")}</button></div></div><div class="editor-chat-location">${icon("ea7a")} Local &nbsp; ${icon("eaf7")} orbit</div></form></aside></div><div class="editor-statusbar"><span>${icon("ea83")} orbit &nbsp; ${icon("ea87")} 0 &nbsp; ${icon("ea6c")} 0</span><span>Ln 1, Col 1 &nbsp; Spaces: 2 &nbsp; UTF-8 &nbsp; LF &nbsp; <span id="editor-language">TypeScript React</span> &nbsp; ${icon("eaa2")}</span></div></div>`;
  }
  function bind(root) {
    const shell = root.querySelector(".editor-shell");
    if (!shell) return;
    const selectFile = (name) => {
      if (!files[name]) return;
      if (
        ![...root.querySelectorAll("[data-tab-name]")].some(
          (tab) => tab.dataset.tabName === name,
        )
      )
        root
          .querySelector(".editor-tab-actions")
          .insertAdjacentHTML("beforebegin", tabMarkup(name));
      root.querySelector(".editor-code-scroll").scrollTop = 0;
      root.querySelector("#editor-source").innerHTML = code(name);
      root.querySelector("#editor-current-file").textContent = name;
      root.querySelector("#editor-context-file").textContent = name;
      root.querySelector("#editor-language").textContent = name.endsWith("css")
        ? "CSS"
        : name.endsWith("json")
          ? "JSON"
          : name.endsWith("md")
            ? "Markdown"
            : "TypeScript React";
      root
        .querySelectorAll("[data-editor-file]")
        .forEach((b) =>
          b.classList.toggle("selected", b.dataset.editorFile === name),
        );
    };
    root.addEventListener(
      "click",
      (event) => {
        const close = event.target.closest("[data-editor-close]");
        if (close) {
          const name = close.dataset.editorClose;
          close.closest("[data-tab-name]").remove();
          const next = root.querySelector("[data-tab-name]");
          if (next) selectFile(next.dataset.tabName);
          else {
            root.querySelector("#editor-source").innerHTML =
              '<div class="editor-empty">Select a file from Explorer to open it.</div>';
            root.querySelector("#editor-current-file").textContent =
              "No file open";
            root.querySelector("#editor-context-file").textContent = "No file";
            root
              .querySelectorAll(".editor-file")
              .forEach((b) => b.classList.remove("selected"));
          }
          return;
        }
        const file = event.target.closest("[data-editor-file]");
        if (file) selectFile(file.dataset.editorFile);
        const action = event.target.closest("[data-editor-action]")?.dataset
          .editorAction;
        if (action === "terminal") {
          const p = root.querySelector(".editor-bottom-panel");
          p.hidden = !p.hidden;
        }
        if (action === "chat") {
          if (matchMedia("(max-width:700px)").matches) {
            shell.classList.remove("hide-chat");
            shell.classList.toggle("mobile-chat");
          } else shell.classList.toggle("hide-chat");
        }
        if (action === "explorer") shell.classList.toggle("hide-explorer");
        if (action === "clear-chat") {
          root.querySelector(".editor-chat-history").innerHTML =
            '<div class="editor-welcome"><img src="assets/studio-mark.svg" alt="" width="84" height="50"><h3>Backboard Desktop</h3><p>What would you like to build?</p></div>';
        }
        const view =
          event.target.closest("[data-editor-view]")?.dataset.editorView;
        if (view) {
          shell.classList.remove("hide-explorer");
          root.querySelector(".editor-search-box").hidden = view !== "search";
          root.querySelector("#explorer-title").textContent = {
            files: "Explorer",
            search: "Search",
            changes: "Source Control",
          }[view];
          root
            .querySelectorAll(".editor-file")
            .forEach(
              (b) =>
                (b.hidden =
                  view === "changes" &&
                  !["settings.tsx", "theme.css"].includes(
                    b.dataset.editorFile,
                  )),
            );
          root
            .querySelectorAll("[data-editor-view]")
            .forEach((b) =>
              b.classList.toggle("selected", b.dataset.editorView === view),
            );
          if (view === "search") root.querySelector("input").focus();
        }
      },
      { signal: controller.signal },
    );
    root
      .querySelector("input")
      .addEventListener("input", (event) =>
        root
          .querySelectorAll(".editor-file")
          .forEach(
            (b) =>
              (b.hidden = !b.dataset.editorFile
                .toLowerCase()
                .includes(event.target.value.toLowerCase())),
          ),
      );
    root.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = root.querySelector("textarea");
      const text = input.value.trim();
      if (!text) return;
      const history = root.querySelector(".editor-chat-history");
      history.querySelector(".editor-welcome")?.remove();
      const message = document.createElement("p");
      message.className = "editor-user";
      message.textContent = text;
      history.append(message);
      const reply = document.createElement("div");
      reply.className = "editor-reply";
      reply.innerHTML = `<small>INTERACTIVE DEMO</small><p>I’ve reviewed <strong>${root.querySelector("#editor-current-file").textContent}</strong>. Try switching files in Explorer, opening the terminal, or reviewing the modified files in Source Control.</p><span>✓ Ready for review</span>`;
      history.append(reply);
      input.value = "";
      history.scrollTop = history.scrollHeight;
    });
    root.querySelector("textarea").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        root.querySelector("form").requestSubmit();
      }
    });
  }
  let controller = new AbortController();
  return {
    markup,
    bind(root) {
      controller.abort();
      controller = new AbortController();
      bind(root);
    },
  };
})();
