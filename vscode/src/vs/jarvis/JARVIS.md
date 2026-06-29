# Jarvis Page

Jarvis is a standalone Backboard IDE window that turns short voice or text commands into
real terminal sessions. It owns four named terminal "cards" (Erin, Seif, Youseph, Nir),
opens them through `node-pty` in the Electron main process, streams their output back over
IPC, and renders each one with an embedded `xterm.js` terminal. It can be driven with a
keyboard, with natural language, or with the microphone — all of which route through the
Backboard API so the same tool-calling model can decide what to do.

This document describes the files, the IPC endpoints, the Backboard API calls, the
terminal lifecycle, the voice/text command pipeline, and the exact way each terminal card
appears and behaves.

---

## File layout

All source lives under `src/vs/jarvis/`:

```
src/vs/jarvis/
├── jarvis.desktop.main.ts        # Renderer entry point; boots JarvisApp
├── browser/
│   ├── jarvisApp.ts              # The entire UI, state machine, and command pipeline
│   └── media/
│       ├── jarvis.css            # Layout, glassmorphism, card styling, responsive rules
│       └── jarvis-background.mp4 # Looping background video behind the shell
├── common/
│   └── jarvisTypes.ts            # Shared TypeScript interfaces (bridge + events)
└── electron-browser/
    ├── jarvis.html               # Production host page
    ├── jarvis-dev.html           # Dev host page (same, without xterm.css import)
    ├── jarvis.ts                 # Bootstrap script loaded by the host page
    └── jarvisBridge.ts           # IJarvisBridge impl that wraps ipcRenderer
```

The main-process counterpart lives in `src/vs/code/electron-main/app.ts`
(functions `transcribeJarvisVoice`, `interpretJarvisCommand`,
`handleJarvisTerminalCommand`, `selectJarvisWorkspaceFolder`, and the
`vscode:jarvisSwitchWindowKind` handler). The window itself is created by
`WindowsMainService.openJarvisWindow` and flagged with `isJarvisWindow` in the
window configuration.

---

## How the Jarvis window opens

There are three entry points:

1. **CLI flag**: `--jarvis` (`src/vs/platform/environment/node/argv.ts`).
   `app.ts` checks `args['jarvis']` during startup and calls
   `windowsMainService.openJarvisWindow({ context, cli: args, initialStartup: true })`.
2. **Command palette**: `workbench.action.openJarvisWindow`
   (`src/vs/workbench/contrib/chat/electron-browser/agentSessions/agentSessionsActions.ts`)
   and `agents.openJarvisWindow`
   (`src/vs/sessions/electron-browser/actions/vscodeActions.ts`). Both call
   `nativeHostService.openJarvisWindow()`, which forwards to
   `NativeHostMainService.openJarvisWindow` -> `WindowsMainService.openJarvisWindow`.
3. **From another Backboard window**: the Jarvis/Optimus/Agents side rails and the
   header mode-select send `vscode:jarvisSwitchWindowKind` with target `jarvis`
   (see "Window switching" below).

`WindowsMainService.openJarvisWindow` (`windowsMainService.ts`) prefers to reuse the
current/focused/last-active window when called from an already-running window
(`!initialStartup`); otherwise it opens a brand-new window with `jarvisWindow: true`.
That flag propagates through `windowsMainService.ts` -> `windowImpl.ts` and forces the
window to load the Jarvis host page instead of the workbench:

```ts
// src/vs/platform/windows/electron-main/windowImpl.ts
if (configuration.isJarvisWindow) {
  windowUrl = FileAccess.asBrowserUri(
    `vs/jarvis/electron-browser/jarvis${isBuilt ? '' : '-dev'}.html`
  ).toString(true);
}
```

For Jarvis/Optimus/Sessions windows, `webPreferences.backgroundThrottling` is set to
`false` so the terminal streams stay responsive even when the window is not focused.

---

## Host page and bootstrap

`jarvis.html` / `jarvis-dev.html` declare the Content Security Policy, pull in
`xterm.css` and `jarvis.css`, and load `jarvis.js` as a module:

```html
<link rel="stylesheet" href="../../workbench/contrib/terminal/browser/media/xterm.css">
<link rel="stylesheet" href="../browser/media/jarvis.css">
<script src="./jarvis.js" type="module"></script>
```

`jarvis.ts` is a tiny bootstrap: it resolves the `INativeWindowConfiguration` from the
preload globals, sets NLS messages, computes the `vscode-file://` base URL, and
dynamically imports `vs/jarvis/jarvis.desktop.main.js`.

`jarvis.desktop.main.ts` waits for `DOMContentLoaded`, adds the `jarvis-standalone`
class to `<body>`, constructs an `ElectronJarvisBridge`, and starts the app:

```ts
const app = new JarvisApp(mainWindow.document.body, new ElectronJarvisBridge());
await app.start();
```

---

## Renderer / main-process contract (`IJarvisBridge`)

`common/jarvisTypes.ts` defines the shared types. The renderer never touches
`ipcRenderer` directly; it goes through `IJarvisBridge`, which in the desktop build is
implemented by `ElectronJarvisBridge`.

### IPC channels

| Channel | Direction | Payload in | Payload out | Purpose |
|---|---|---|---|---|
| `vscode:jarvisTerminalCommand` | renderer -> main | `{ type, slotId, terminalName?, data?, cwd? }` | `{ accepted, slotId?, error? }` | Open / write to / dispose a pty |
| `vscode:jarvisTerminalData` | main -> renderer | `{ slotId, data }` | — | Stream bytes from the pty to the card |
| `vscode:jarvisTerminalExit` | main -> renderer | `{ slotId, exitCode?, signal? }` | — | Notify the card that its pty exited |
| `vscode:jarvisSelectWorkspaceFolder` | renderer -> main (invoke) | `currentPath?: string` | `{ accepted, path?, error? }` | Open a native folder picker |
| `vscode:jarvisVoiceTranscribe` | renderer -> main (invoke) | `{ audio, mimeType, systemPrompt, tools }` | `{ accepted, transcript?, toolCalls?, error? }` | Send mic audio to the Backboard API |
| `vscode:jarvisInterpretCommand` | renderer -> main (invoke) | `{ text, systemPrompt, tools }` | `{ accepted, text?, toolCalls?, error? }` | Send typed text to the Backboard API |
| `vscode:jarvisSwitchWindowKind` | renderer -> main (invoke) | `'editor' \| 'agents' \| 'optimus' \| 'jarvis'` | `{ accepted, error? }` | Switch the current window to another Backboard surface |

The bridge subscribes to the two event channels in its constructor and returns
`{ dispose() }` handles that `JarvisApp` registers with its `Disposable`:

```ts
this._register(this.bridge.onTerminalData(event => { ... }));
this._register(this.bridge.onTerminalExit(event => { ... }));
```

### `IJarvisBridge` surface

```ts
interface IJarvisBridge {
  onTerminalData(listener): { dispose() };
  onTerminalExit(listener): { dispose() };
  openTerminal(slotId, terminalName, cwd?): Promise<void>;
  writeTerminal(slotId, data): Promise<void>;
  disposeTerminal(slotId): Promise<void>;
  selectWorkspaceFolder(currentPath?): Promise<IJarvisWorkspaceSelectionResult>;
  transcribeVoice(audio, mimeType, systemPrompt, tools): Promise<IJarvisVoiceTranscriptionResult>;
  interpretCommand(text, systemPrompt, tools): Promise<IJarvisCommandInterpretationResult>;
  openEditor(): Promise<void>;
  openAgents(): Promise<void>;
  openOptimus(): Promise<void>;
  openJarvis(): Promise<void>;
}
```

The terminal command methods are thin wrappers around
`ipcRenderer.invoke('vscode:jarvisTerminalCommand', ...)`; `openEditor/Agents/Optimus/Jarvis`
all funnel through `switchWindowKind`.

---

## Main-process terminal handling

All terminal logic in the main process is in `app.ts`:

- `jarvisTerminals: Map<string, IJarvisTerminalProcess>` — one entry per active slot,
  keyed by `slotId`, storing the owning `WebContents` id and the `node-pty` `IPty`.
- `jarvisOwnerDestroyListeners: Set<number>` — makes sure each owner window only
  registers one `destroyed` listener.
- `getJarvisNodePty()` lazily `import('node-pty')` and caches it.
- `jarvisDefaultShell()` returns `process.env.SHELL || /bin/zsh` with `['-l']` on
  macOS/Linux, or `ComSpec`/`cmd.exe` on Windows.

### `vscode:jarvisTerminalCommand`

Handler: `handleJarvisTerminalCommand(sender, value)`.

1. `parseJarvisTerminalCommand(value)` validates that `type` is one of
   `openTerminal | writeTerminal | disposeTerminal` and that `slotId` is a non-empty
   string. Anything else returns `{ accepted: false, error: 'Invalid Jarvis terminal command.' }`.
2. `ensureJarvisOwnerCleanup(sender)` registers a one-shot `destroyed` listener on the
   sender so that when the Jarvis window closes, every pty it owns is killed and removed
   from the map.
3. Dispatches:

   - **`openTerminal`** -> `openJarvisTerminal(sender, command)`:
     - If the slot already has a pty, it writes a friendly
       `[Jarvis] {name} is already running.\r\n` line back and returns — it does **not**
       spawn a second process.
     - Otherwise it spawns a pty with `cols: 124, rows: 34`, `cwd = jarvisTerminalCwd(command.cwd)`
       (the selected workspace folder if it exists, else `homedir()`), and an env that
       spreads `process.env` and sets `TERM_PROGRAM: 'jarvis'`.
     - `pty.onData(data => sender.send('vscode:jarvisTerminalData', { slotId, data }))`
       is the byte stream the renderer renders.
     - `pty.onExit(event => { jarvisTerminals.delete(slotId); sender.send('vscode:jarvisTerminalExit', { slotId, exitCode, signal }) })`
       cleans up and notifies the card.
     - It immediately writes a banner:
       `[Jarvis] Opened {terminalName} in {cwd}.\r\n`.

   - **`writeTerminal`** -> `writeJarvisTerminal(command)`:
     - Looks up the pty by `slotId`; if missing, throws
       `Jarvis terminal {slotId} is not running.` (which the bridge surfaces as
       `{ accepted: false, error }`).
     - Otherwise `terminal.pty.write(command.data ?? '')` — raw bytes, no quoting.

   - **`disposeTerminal`** -> `disposeJarvisTerminal(slotId)`:
     - Removes the entry from the map and calls `terminal.pty.kill()`.
     - The `pty.onExit` callback will **not** fire (kill does not emit exit for a
       forcibly-killed pty in all cases), so the renderer sets the slot back to
       `idle` itself once the IPC call resolves.

### `vscode:jarvisTerminalData` / `vscode:jarvisTerminalExit`

These are `sender.send(...)` events emitted from inside `openJarvisTerminal`. The bridge
re-broadcasts them to any registered listener, and `JarvisApp` updates the slot state
(see "Terminal card lifecycle" below).

### `vscode:jarvisSelectWorkspaceFolder`

`selectJarvisWorkspaceFolder(sender, currentPath)` uses Electron's `dialog.showOpenDialog`
attached to the owner `BrowserWindow` (if available) with
`properties: ['openDirectory', 'createDirectory']` and a default path of `currentPath`
or `homedir()`. Returns `{ accepted: true, path }` on success or
`{ accepted: false }` if the user cancels.

### `vscode:jarvisSwitchWindowKind`

Routes the request to the right `WindowsMainService` opener:

- `editor` -> `openEmptyWindow({ context: API, contextWindowId }, { forceReuseWindow: true })`.
- `agents` -> `openAgentsWindow({ ..., forceReuseWindow: true })`.
- `optimus` -> `openOptimusWindow({ ... })`.
- `jarvis` -> if the current window is not already a Jarvis window, `openJarvisWindow`;
  otherwise a no-op success.

Unknown targets return `{ accepted: false, error: 'Unknown window kind: ...' }`.

---

## Backboard API integration

Both voice transcription and text interpretation hit the same Backboard endpoint
family. Configuration is read from `~/.backboard_ide/config.json`
(`readJarvisBackboardConfig()`); the API URL defaults to
`https://app.backboard.io/api` (`jarvisBackboardApiUrl`) and the API key is resolved
from `api_key` / `apiKey` / `backboard_api_key` / `personal_api_key`, or
`env_keys[<env>]` where `env` defaults to `prod` (`jarvisBackboardApiKey`).

### `transcribeJarvisVoice(value)` — `vscode:jarvisVoiceTranscribe`

1. Validates the record and extracts `audio` (via `jarvisVoiceAudioBytes`, which
   accepts a number array, `ArrayBuffer`, or any `ArrayBuffer.isView`) plus
   `mimeType` (default `audio/webm`), `systemPrompt`, and `tools`.
2. If no API key is configured, returns
   `{ accepted: false, error: 'No Backboard API key found in ~/.backboard_ide/config.json.' }`.
3. Calls `postJarvisVoiceToBackboard(apiUrl, apiKey, audioBytes, mimeType, systemPrompt, tools, sendToLlm = true)`,
   which is a multipart `POST {apiUrl}/threads/messages`:

   ```
   X-API-Key: <apiKey>
   Content-Type: multipart/form-data

   stream=false
   content=
   send_to_llm=true
   voice={ stt: { provider: 'openai', model: 'gpt-4o-mini-transcribe', language: 'en' },
           system_prompt?, tools?, send_to_llm: true, client: 'jarvis' }
   system_prompt?=<systemPrompt>
   tools?=<JSON tools>
   audio_file=<Blob of audioBytes, type=mimeType, filename='jarvis-voice.webm'>
   ```

4. If the request fails **and** a system prompt or tools were provided, it retries
   with `sendToLlm = false` and no prompt/tools — i.e. a pure speech-to-text pass so
   the user still gets a transcript back even when the tool-calling model rejects
   the input.
5. On success it parses the JSON body with `extractJarvisBackboardTranscript` and
   `extractJarvisBackboardToolCalls`. A response is only considered accepted if it
   yields a transcript **or** at least one tool call; otherwise:
   `{ accepted: false, error: 'Backboard response did not include a transcript or tool call.' }`.

### `interpretJarvisCommand(value)` — `vscode:jarvisInterpretCommand`

Same shape, but uses `postJarvisTextToBackboard`, which sends JSON:

```json
POST {apiUrl}/threads/messages
X-API-Key: <apiKey>
Content-Type: application/json

{
  "content": "<text>",
  "stream": false,
  "send_to_llm": true,
  "parallel_tool_calls": false,
  "metadata": { "client": "jarvis" },
  "system_prompt": "<systemPrompt>",
  "tools": [<tools>]
}
```

It also retries without prompt/tools on non-2xx, then returns
`{ accepted: true, text: interpretedText ?? text, toolCalls }`. Note that the
returned `text` may be the model's restatement of the user's command, not the raw
input.

### Response parsing

`extractJarvisBackboardTranscript(value)` is deliberately permissive about Backboard's
response shape. It checks, in order:

- top-level `transcript` / `text`;
- `messages[]` (or the root if it's not an array), looking at each message's
  `voice_records.stt.transcript|text|message` or `message.content|message`.

`extractJarvisBackboardToolCalls(value)` walks the entire payload recursively
(`collectJarvisBackboardToolCalls` with a `seen` set to avoid cycles) and collects any
object that looks like a tool call. It recognizes several common shapes:

- Direct: `{ name, args | arguments | parameters | input }`.
- OpenAI-style: `{ type: 'function', function: { name, arguments } }`.
- Nested arrays under `tool_calls`, `toolCalls`, `actions`, `function_calls`,
  `functionCalls`.
- Nested objects under `message`, `messages`, `response`, `output`, `data`,
  `choice(s)`, `assistant`, `run(s)`, `required_action`, `submit_tool_outputs`.
- Tool calls embedded inside a message `content` / `text` string that happens to be
  valid JSON starting with `{` or `[`.

`normalizeJarvisVoiceToolCall` rejects anything whose `name` is not one of the three
Jarvis tools (`isJarvisVoiceToolName`):

- `open_terminal`
- `send_terminal_input`
- `close_terminal`

Anything else is dropped silently. Tool arguments may be an object, a JSON string
(which is parsed), or anything else (which becomes `{}`).

---

## Voice tools and the system prompt

The renderer ships a fixed system prompt and tool schema in `jarvisApp.ts`:

```
JARVIS_SYSTEM_PROMPT = [
  'You are Jarvis, the Backboard IDE voice control surface.',
  'Your job is to convert short voice commands into tool calls for the Jarvis page.',
  'Available terminal slots are Erin, Seif, Youseph, and Nir.',
  'When the user says "hey backboard, open a terminal", call open_terminal. ...',
  'When the user says "open Codex CLI", call open_terminal with cli: "codex". ...',
  'If the user names a slot, use that slot. ... make Erin tell me a short story -> send_terminal_input with slot: "Erin" and input: "tell me a short story".',
  'When the user asks to type, run, ask, make, or tell something in a terminal, call send_terminal_input with the exact requested input.',
  'When the user asks to close a terminal, call close_terminal.',
  'Do not send normal coding chat messages from this page. Jarvis controls terminal cards only.'
].join('\n');
```

The tools are `open_terminal`, `send_terminal_input`, and `close_terminal`, each with
a `slot` enum of `['Erin', 'Seif', 'Youseph', 'Nir']`. `open_terminal` also accepts
`count` (1..4) and `cli` (`'backboard' | 'codex'`). `send_terminal_input` requires
`input` and optionally `slot`.

These tool definitions are sent on **every** voice transcription and on every typed
command interpretation, so the model always knows the surface it is driving.

---

## The four terminal cards

`terminalSlots` is a hardcoded list:

```ts
const terminalSlots: readonly IJarvisTerminalSlot[] = [
  { id: 'erin', name: 'Erin' },
  { id: 'seif', name: 'Seif' },
  { id: 'youseph', name: 'Youseph' },
  { id: 'nir', name: 'Nir' }
];
```

Each slot has runtime state in `IJarvisSlotState`:

```ts
interface IJarvisSlotState {
  id: string;
  name: string;
  status: 'idle' | 'opening' | 'running' | 'closed' | 'error';
  output: string;            // capped to the last 50,000 chars
  commandDraft: string;      // text typed into the card's input that hasn't been sent
  cli: 'backboard' | 'codex';
  terminal?: XtermTerminal;  // lazily created xterm.js instance
  terminalInputDisposable?: IDisposable;  // onData subscription for user keystrokes
  lastPrompt?: string;       // last prompt sent to this slot (shown in the placeholder)
  error?: string;
}
```

### Terminal card lifecycle

A slot starts `idle`. State transitions:

- `idle` -> `opening` when `openTerminal(slotId, cli)` is called (voice tool, typed
  command, or the per-card `+` button). The app immediately renders the card with the
  `opening` class and the status label "Opening Backboard"/"Opening Codex CLI". It also
  seeds `slot.output` with `[Jarvis] Opening {name}...\r\n`.
- `opening` -> `running` after `bridge.openTerminal(...)` resolves. The app writes the
  chosen CLI command (`Backboard` or `codex`) followed by `\r` to the pty, enables
  stdin in xterm, and focuses the terminal. From this point on, every
  `onTerminalData` event writes into the xterm instance directly (no re-render), and
  flips `slot.status` to `'running'` if it wasn't already.
- `running` -> `closed` when `onTerminalExit` fires (unless the slot was already
  `idle`, which means the event is for a stale/unknown slot and is ignored). The app
  appends `\r\n[Jarvis] Terminal exited with code {exitCode}.\r\n` and re-renders.
- `*` -> `error` if `bridge.openTerminal` throws. The error message is appended to
  the output and shown in the status line; the card gets the `error` class.
- `*` -> `idle` when the user clicks the card's `x` button or says "close terminal".
  `disposeTerminal(slotId)` calls `bridge.disposeTerminal`, then resets `output`,
  `commandDraft`, disposes the xterm, and re-renders. The card disappears from the
  grid entirely because `renderGrid` filters out `idle` slots.

### How a terminal card appears

Each visible card is an `<article class="jarvis-card {status}">` built by
`renderCard(slot)`. Layout (top to bottom):

1. **Header** (`jarvis-card-header`)
   - Identity group: a colored status dot (`jarvis-card-dot`) and the slot name
     (`<h2>`).
   - A `+` icon button (`jarvis-icon-button`) to open the terminal. Disabled while
     the slot is `opening` or `running`.
2. **Meta line** (`jarvis-card-meta`): a one-line status label produced by
   `statusLabel(slot)`:
   - `idle`: "Ready to open by voice or button"
   - `opening`: "Opening Backboard" / "Opening Codex CLI"
   - `running`: "Backboard running" / "Codex CLI running"
   - `closed`: "Terminal closed"
   - `error`: the error message
3. **Terminal surface** (`jarvis-terminal`): a container `<div>` that hosts the
   xterm.js instance (see below).
4. **Per-card command form** (`jarvis-terminal-command`): a text input, a `>` submit
   button, and an `x` close button. The input is disabled unless the slot is
   `running`. Submitting sends `input.value + '\r'` to the pty via
   `sendTerminalInput`.

The status dot is grey by default; orange (`#ff6e49`) with a soft halo when
`running`; the focus color when `opening`; the danger color when `error`. The card's
border thickens to `--jarvis-border-strong` while running.

### xterm.js rendering

`attachTerminal(slot, container)` lazily creates an `xterm.Terminal` per slot with:

```ts
{
  allowTransparency: true,
  cols: 124, rows: 34,
  cursorBlink: true, cursorStyle: 'bar',
  disableStdin: slot.status !== 'running',
  documentOverride: this.container.ownerDocument,
  drawBoldTextInBrightColors: true,
  fontFamily: cssValue('--vscode-editor-font-family', 'Menlo, Monaco, Consolas, monospace'),
  fontSize: terminalFontSize(),   // clamped to [11, 14], default 13
  lineHeight: 1.22,
  scrollback: 5000,
  theme: terminalTheme()
}
```

The theme (`terminalTheme()`) maps Backboard/VSCS terminal ANSI CSS variables to
xterm colors, with a transparent background so the card glass shows through:

```ts
{
  background: 'rgba(0, 0, 0, 0)',
  foreground: '--jarvis-text' or '#f9f4ef',
  cursor: '--vscode-terminalCursor-foreground' or '--jarvis-focus' or '#8cbcff',
  selectionBackground: '--vscode-terminal-selectionBackground' or 'rgba(120,160,255,.32)',
  black/red/green/yellow/blue/magenta/cyan/white + bright* mapped to --vscode-terminal-ansi* variants
}
```

Once created, the terminal is `open(container)`-ed, the cached `slot.output` is
flushed into it, or — if there is no output yet — a placeholder is written:

```
$ hey backboard, open a terminal
# {SlotName} is waiting
# Last prompt: {lastPrompt}    (only if set)
```

Keystrokes are wired through `slot.terminal.onData(data => bridge.writeTerminal(slot.id, data))`
so typing in the xterm goes straight to the pty. On re-render (e.g. after the grid
layout changes), `attachTerminal` re-parents the existing xterm element into the new
container and calls `resizeTerminalToContainer`, which computes cols/rows from the
container's pixel size and the current font size and calls `slot.terminal.resize`.

### Grid layout

`renderGrid()` filters to non-`idle` slots and toggles CSS classes:

- `empty` when nothing is open (the grid is hidden).
- `count-1`, `count-2`, `count-3` (no class for 4) to reshape the grid.

Default (4 cards or unspecified count) is a 2x2 grid of at least 360x280 cards. The
variants:

- `count-1`: one full-width card.
- `count-2`: two columns, one row.
- `count-3`: two rows; the first card spans both rows (a tall left column).

Responsive breakpoints in `jarvis.css` collapse everything to a single scrollable
column at <=1120px, hide the side rail at <=720px, and shrink the mic button / hide
meta lines at <=520px or <=620px height.

---

## The page shell

`start()` builds the following DOM inside `container`:

```
div.jarvis-shell
├── div.jarvis-background
│   └── video.jarvis-background-video  (autoplay, loop, muted, playsInline)
├── header.jarvis-header
│   ├── select.jarvis-mode-select      (Editor / Agents / Jarvis)
│   ├── button.jarvis-workspace-select (workspace folder label)
│   ├── div.jarvis-brand > h1 "Jarvis" + p "Voice terminal launcher"
│   └── div.jarvis-status-line         (single-line status messages)
├── nav.jarvis-side-rail               (decorative tool glyphs)
├── form.jarvis-command-bar
│   ├── input.jarvis-prompt-input      ("Hey Backboard, open a terminal")
│   └── button.jarvis-mic-button
└── section.jarvis-grid                (the terminal cards)
```

### Header

- **Mode select** (`jarvis-mode-select`): a pill dropdown with `Editor`, `Agents`, and
  a hidden `Jarvis` option. The current value is pinned to `jarvis`; choosing `editor`
  calls `bridge.openEditor()` and choosing `agents` calls `bridge.openAgents()`, then
  the select resets to `jarvis`. (The Jarvis option is hidden because you're already
  there; it exists only so the select can represent the current state.)
- **Workspace button** (`jarvis-workspace-select`): shows "Select folder" or the
  basename of the selected workspace (`workspaceLabel` trims trailing slashes and
  takes the last path segment). Clicking it calls `selectWorkspaceFolder()`.
- **Brand**: a small `Jarvis` heading. The "Voice terminal launcher" subtitle is
  hidden in CSS (`.jarvis-brand p { display: none; }`).
- **Status line**: a single-line, ellipsized status message. It is updated throughout
  the flow ("Ready...", "Listening...", "Transcribing with Backboard...", "Opened
  Erin with Backboard.", etc.) by `updateStatus(message)`.

### Side rail

`renderSideRail()` builds a vertical pill of 9 buttons labeled with decorative glyphs
(`↖`, `◉`, `▢`, `◇`, `○`, `↗`, `/`, `~`, `AI`). They are not wired to any behavior —
they are visual tool placeholders. The rail is hidden at <=720px width.

### Command bar

A `<form>` with:

- `promptInput` (`jarvis-prompt-input`): a borderless, left-aligned, 15px/600 input
  with the placeholder "Hey Backboard, open a terminal". Submitting the form calls
  `runCommand(promptInput.value)` and clears the input.
- `voiceButton` (`jarvis-button jarvis-mic-button`): the microphone. Clicking it
  toggles voice recording.

The mic button is drawn entirely with CSS — a rounded rectangle for the mic body
(`::before`) and a curved stand (`::after`). While listening it gets the `listening`
class, which triggers the `jarvis-mic-pulse` keyframe animation (a pulsing box-shadow
ring on a 1.35s loop).

`installBackboardVoice()` disables the button if `navigator.mediaDevices.getUserMedia`
or `MediaRecorder` is unavailable in the current runtime.

---

## Voice command pipeline

1. **Start recording** (`toggleVoice` -> `startVoiceRecording`): requests
   `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })`,
   picks the best supported mime type (`audio/webm;codecs=opus` -> `audio/webm` -> `''`),
   creates a `MediaRecorder`, collects chunks in `voiceChunks`, and starts recording.
   The button switches to the `listening` state and the status line says "Listening
   through Backboard voice. Click Listening when done."
2. **Stop recording** (`stopVoiceRecording`): stops the recorder, which fires
   `onstop` -> `transcribeVoiceRecording(mimeType)`.
3. **Transcribe**: assembles the chunks into a `Blob`, converts to `Uint8Array`, and
   calls `bridge.transcribeVoice(audio, mimeType, JARVIS_SYSTEM_PROMPT, JARVIS_VOICE_TOOLS)`.
   Status becomes "Transcribing with Backboard...".
4. **Interpret the result**:
   - If the response includes `transcript`, it is placed into `promptInput.value` so
     the user sees what was heard.
   - If the response includes `toolCalls`, each is executed in order via
     `executeVoiceToolCall` and the status line lists the summaries
     ("Jarvis ran: opened Erin with Backboard, sent prompt to Erin.").
   - If there are no tool calls but there is a transcript, it is passed to
     `runCommand(transcript)` (the typed-command path below).
   - If there is neither, the error "Backboard response did not include a transcript or
     tool call." is thrown.

---

## Typed command pipeline

`runCommand(rawCommand)` is used both by the command bar (form submit) and by the
voice path when only a transcript came back.

1. Status: "Asking Backboard to choose a Jarvis tool...".
2. `bridge.interpretCommand(command, JARVIS_SYSTEM_PROMPT, JARVIS_VOICE_TOOLS)` sends
   the text to the Backboard API with the same tool schema as voice.
3. If the model returns tool calls, they are executed via `executeVoiceToolCall` and
   the status line reports the summaries.
4. If no tool calls come back, `acceptNaturalCommand(command)` runs a small local
   fallback parser:

   - Strips the wake word `hey backboard` / `hey jarvis`.
   - Detects `codex` vs `backboard` (`cliFromCommand`).
   - If the command matches `open|start|create|launch` + `terminal|shell|cli|codex|backboard`,
     it opens `numberFromCommand(command) ?? 1` terminals (digit 1-4, or words like
     "one", "two", "three", "four", "all", "a", "single", "too/to", "for"). If a slot
     name is mentioned it tries that slot first.
   - If a named slot is mentioned with an instruction ("make Erin tell me a short
     story"), `promptForNamedSlot` strips the prefix ("make/ask/tell/have Erin",
     "Erin ...") and sends the remainder to that slot via `sendPromptToSlot`.
   - Otherwise it shows: `Jarvis heard "{command}". Try: Hey Backboard, open 3 terminals.`

`executeVoiceToolCall(toolCall)` is the dispatcher for both paths:

- **`open_terminal`**: `cliFromArgs` reads `args.cli | args.tool | args.terminalType`;
  `countFromArgs` clamps `args.count` to 1..4; `slotFromArgs` matches
  `args.slot | args.name | args.person | args.terminal` against slot ids/names
  (case-insensitive). It then calls `openAvailableTerminals(count, slot, cli)`, which
  picks `count` non-running slots (or just the preferred slot if given) and opens
  each. Returns "opened Erin, Seif with Backboard" or "no terminals opened".
- **`send_terminal_input`**: picks the slot from args, or the first running slot if
  none specified; reads `args.input | args.text | args.command | args.prompt`; sends
  the text to that slot via `sendPromptToSlot`. If the slot isn't running it opens a
  Backboard terminal in it, waits 700ms for the shell to come up, then sends the text.
- **`close_terminal`**: picks the slot from args or the first running slot, and
  disposes it. Returns "closed Erin" or "no running terminal to close".

---

## Workspace folder

`selectWorkspaceFolder()` calls `bridge.selectWorkspaceFolder(this.selectedWorkspacePath)`,
which opens the native dialog. On success:

1. `selectedWorkspacePath` is updated.
2. `updateWorkspaceButton()` relabels the header button with the folder basename.
3. `applyWorkspaceToRunningTerminals(workspacePath)` writes
   `cd '<workspacePath>'\r` to every running slot's pty, so existing terminals jump
   to the new folder. Paths are shell-quoted with `shellQuote` (single quotes, inner
   quotes escaped).

The selected workspace is also passed as the `cwd` to every newly opened terminal
(`openTerminal` -> `bridge.openTerminal(slot.id, slot.name, this.selectedWorkspacePath)`).
The main process validates that the path exists and is a directory before using it;
otherwise it falls back to `homedir()`.

---

## CSS / visual design

The whole page is a warm, peach-toned glassmorphism surface:

- `--jarvis-bg: #f6d6cc` (peach) base, with a looping background video and a
  radial/linear gradient overlay (`.jarvis-background::after`) adding light blooms.
- `--jarvis-glass: rgba(248, 242, 234, .82)` for the header and side rail.
- `--jarvis-card: rgba(51, 43, 62, .82)` for the terminal cards (dark glass over the
  peach background).
- `--jarvis-border: rgba(255, 120, 92, .76)` (coral) for card borders; the strong
  variant is used when a card is `running`.
- `--jarvis-button-bg: #ff7e67` / `--jarvis-button-hover: #ff684d` for the mic and
  primary buttons.
- `--jarvis-terminal: rgba(39, 36, 53, .42)` for the terminal surface (dark but
  translucent so the card glass shows through).
- `--jarvis-control-text: #463934` for text on the light glass surfaces (header,
  command bar, side rail).

All interactive surfaces use `backdrop-filter: blur(...)` and `box-shadow` for depth.
The header is horizontally centered at the top; the command bar is centered at the
bottom; the side rail is a vertical pill on the left; the grid fills the middle
(`inset: 76px 74px 92px 74px`). The header and side rail are `-webkit-app-region: drag`
so they can be used to move the frameless window, while the controls inside are
`no-drag`.

---

## Lifecycle and cleanup

`JarvisApp extends Disposable`. On dispose:

- any pending `voiceFallbackTimer` is cleared;
- the `MediaRecorder`, if active, is stopped;
- `mediaStream` tracks are released;
- every slot's xterm instance and `onData` subscription is disposed;
- the bridge subscriptions registered via `_register` are disposed automatically.

On the main-process side, `ensureJarvisOwnerCleanup(sender)` attaches a `destroyed`
listener to the Jarvis window's `WebContents`. When the window closes, the listener
iterates `jarvisTerminals`, kills any pty whose `ownerId` matches, and removes it from
the map — so closing the Jarvis window never orphans shell processes.

---

## Quick end-to-end example

User says into the mic: "Hey Backboard, make Erin tell me a short story."

1. `MediaRecorder` captures webm/opus audio and calls
   `bridge.transcribeVoice(audio, 'audio/webm;codecs=opus', JARVIS_SYSTEM_PROMPT, JARVIS_VOICE_TOOLS)`.
2. The main process `POST`s multipart to `https://app.backboard.io/api/threads/messages`
   with the audio file and the tool schema.
3. Backboard returns a `tool_calls` array containing
   `{ name: 'send_terminal_input', args: { slot: 'Erin', input: 'tell me a short story' } }`.
4. `executeVoiceToolCall` opens a Backboard terminal in the `erin` slot (waiting 700ms
   for the shell), then writes `tell me a short story\r` to it.
5. The main-process pty receives the bytes, Backboard CLI inside the shell produces
   output, and each chunk is sent back via `vscode:jarvisTerminalData` and rendered
   into the `Erin` card's xterm in real time.
6. The status line reads: "Jarvis ran: sent prompt to Erin."