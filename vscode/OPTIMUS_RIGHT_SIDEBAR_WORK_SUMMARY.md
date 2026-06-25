# Optimus Right Sidebar Work Summary

Date: June 25, 2026

## Goal

Make the Optimus right sidebar behave like the Backboard/code editor right panel chat instead of using a separate custom-feeling implementation. The main areas were the composer UI, model picker, voice toggle, streaming display, command data flow, history/live-state handling, and sidebar open/close behavior.

## Files Changed

- `src/vs/optimus/browser/optimusApp.ts`
- `src/vs/optimus/browser/media/optimus.css`
- `src/vs/optimus/common/optimusHistory.ts`
- `src/vs/optimus/electron-browser/optimusHistoryService.ts`
- `src/vs/code/electron-main/app.ts`
- `extensions/backboard/src/extension.ts`

## Optimus Sidebar UI

- Reworked the Optimus sidebar composer to follow the Backboard/code editor right panel pattern more closely.
- Removed the raw native composer selects for model and voice.
- Added a model button with a searchable popover instead of a browser select.
- Added a Backboard voice icon toggle instead of a native voice select.
- Kept the sidebar close/open behavior so the panel can close and reclaim width.
- Fixed the fallback label so the composer no longer shows `Model Model`; it now shows a loading/select state or the actual selected model.

## Model Picker Fixes

- Added model/settings metadata plumbing from the Backboard extension into Optimus.
- Backboard now writes Optimus metadata to `~/.backboard_ide/optimus-metadata.json`.
- Optimus reads that metadata through a new history-provider API.
- The selected model/provider now flows through Optimus prompt options into `optimus-command.json`.
- Backboard receives those options and applies them through `resolveTurnSettings`.
- The selected provider/model is included in the `bridge.send('sendPrompt', ...)` payload.
- Fixed the empty-model-cache bug: an empty cached model array no longer counts as a valid fresh cache.
- Added a stronger Electron main-process fallback: if `optimus-metadata.json` has no models, Optimus reads the real Backboard model cache from `User/globalStorage/backboard.backboard/models.json`.
- Verified the local Backboard model cache contains 378 models.

## Streaming Fixes

- Changed Optimus live rendering so adjacent assistant fragments are coalesced into one assistant message.
- Preserved prior streamed content while live state updates merge in from `~/.backboard_ide/optimus-live-state.json`.
- Added serialized live-state writes in the Backboard extension to avoid live-state file races.
- Added editor-panel-like delta spacing in the direct Optimus streaming path.
- Tightened Optimus chat CSS so streamed assistant text wraps inside the sidebar instead of forcing one long horizontal row.
- Added stronger final CSS cascade rules for:
  - `white-space: pre-wrap`
  - `overflow-wrap: anywhere`
  - `min-inline-size: 0`
  - `max-inline-size: 100%`
  - `overflow-x: hidden`

## Voice Fixes

- Optimus voice control now uses an icon/button.
- The voice button toggles `voiceMode: 'tts'`.
- No broken mic/STT path is exposed from Optimus.
- If Backboard returns voice/media payloads with audio URLs, Optimus renders playable audio controls in the chat stream.

## Backboard Direct Command Flow

- Optimus prompt sends now go through the Backboard extension direct path instead of requiring the editor panel webview to be opened first.
- Backboard command polling was added so Optimus commands are picked up reliably.
- Direct Optimus prompts create/update shared panel state and thread history.
- The direct path writes live state while streaming, then writes final shared history when complete.

## Validation Run

Passed:

```bash
npm --prefix extensions/backboard run compile
./node_modules/.bin/tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck
npm run compile
git diff --check -- <changed files>
```

The user launch flow was also run earlier:

```bash
npm run electron
npm run compile
/usr/bin/nohup ./run-backboard-ide.sh > "$RUN_DIR.launch.log" 2>&1 &
```

The app started, but reliable automated UI click-through was limited because the launch script used the default profile and macOS handed the new window to an already-running Backboard main process without a clean CDP endpoint.

## Important Runtime Note

Because `src/vs/code/electron-main/app.ts` changed, a full Backboard Studio Dev restart is required for the Electron main-process model-cache fallback to take effect. Reloading only the renderer/sidebar will not load the updated main-process code.

## Known Scope Boundaries

- No workbench/rightWorkbench implementation was intentionally added for this task.
- Existing unrelated dirty files in workbench/session/rightWorkbench areas were left untouched.
- The model picker should now show the real Backboard model list after restart because Optimus can read the real Backboard model cache even if Optimus metadata is empty.
