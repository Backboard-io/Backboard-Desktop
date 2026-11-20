# Live updates

Ship Backboard's JavaScript to installed apps without a signed, notarized release. A
full release is still needed for anything native; everything else can go live.

| Component | What it carries | How users get it |
| --- | --- | --- |
| `agent` | cli-ts runtime as a JS bundle (agent loop, tools, prompts, model catalog) | Next turn of each chat. No restart, no prompt. |
| `app` | `out/` and `extensions/` JavaScript (UI, main process, agent host, extensions) | The Update button turns into a ~3 s restart. Also applies at the next launch. |
| `config` | Server flags (`backboard.flag.<name>` context keys) and a one-time announcement | Immediately. |

Needs a full release: Electron, `node_modules` / `package-lock.json`, `cua-driver`,
entitlements, Info.plist, a new cli-ts protocol version, and the live update loader
itself. `publish.mjs` refuses these.

## How it works

- `publish.mjs` writes a signed manifest plus content-addressed files. Apps check it
  every 5 minutes, on window focus, and as soon as the events server pushes a new
  sequence.
- The Backboard extension verifies the Ed25519 signature against the keys in the
  installed app's `product.json`. It then builds `<userData>/LiveUpdates/app/<id>/`:
  unchanged files are cloned from the installed app, changed files are downloaded and
  hash-checked, and native files are symlinked to the signed originals.
- `out/bootstrap-live.js` is the app's entry point. It starts the overlay when its
  signature, base version, base build and Electron version check out, otherwise the
  installed app. If an overlay fails to start 3 times in a row it is marked bad, and
  the installed app runs.
- The agent host runs the bundle with the app's signed `backboard-cli-ts` in Bun
  runtime mode (`BUN_BE_BUN=1`), so no new executable needs signing.

## One-time setup

1. Create the signing key, kept offline and out of the repo:
   ```bash
   node scripts/live-updates/publish.mjs keygen
   ```
2. Ship one full release built after step 1. The package scripts stamp
   `~/.backboard/live-update-signing/public-key.txt` into `product.json`. Releases
   built without a key have live updates off.
3. Optional: deploy `scripts/live-updates/events-server.mjs` behind HTTPS for instant
   pushes, and set `BACKBOARD_LIVE_UPDATE_EVENTS_URL` (e.g. `https://…/events`) for
   release builds. Without it, apps pick changes up at their next poll.

## Publish

Agent only (seconds, no compile):
```bash
BASE_VERSION=3.1.27 COMPONENTS=agent ./scripts/build_live_update_macos.sh --notes "Faster edits"
```

App and agent (unsigned compile, ~20 min, no notarization):
```bash
BASE_VERSION=3.1.27 ./scripts/build_live_update_macos.sh --rollout 10 --notes "Fixes chat scroll"
```

Upload (objects first, manifest last), then optionally announce to connected apps:
```bash
./scripts/upload_live_update.sh --channel stable --platform darwin-arm64 --profile backboard-release
```

Use the `backboard-release` AWS profile (the default profile's key is not valid for the
bucket). With an events server, also set `BACKBOARD_LIVE_EVENTS_PUBLISH_URL` and
`BACKBOARD_LIVE_EVENTS_TOKEN` so connected apps fetch immediately.

Useful `publish.mjs` options: `--rollout N` (percent of machines), `--urgent` (prompt to
restart now), `--bases 3.1.27,3.1.28` (several installed versions; list their builds with
`--builds`, see below), `--config flags.json`.

## Base builds

A version number does not identify a build: a release can be packaged again under the
same number from newer source. Each `app` and `agent` component therefore records
`builds`, the installed apps it was made from, and runs only on those.

- A build id is product.json `backboardBuildInfo.sourceCommit`, plus
  `+<sourceDirtySha256>` when the package included uncommitted changes. Every release
  package script stamps it (Windows stamps the commit only; CI builds are clean). A
  package of the same clean commit has the same id.
- `publish.mjs publish` takes the id from `--base-app` and refuses a base app without
  one. `--builds ID,ID` adds the builds of the other releases named in `--bases`.
- The extension, the boot loader and the agent host refuse a component whose `builds`
  do not include the installed app's, like a version mismatch: the update log says
  why, the installed app (or runtime) runs, and the extension drops the pointer at its
  next check.
- Components without `builds` (published before this check) are **refused**, not
  matched by version. Nothing shows they are not older code than the installed build,
  which is how sandbox 3.1.27 ran stale overlays after its rebuild on 2026-10-27.
  Republish or roll back any `app`/`agent` component still live on a channel;
  `publish.mjs` warns when it carries one over.
- Installs from before this check (their boot loader and extension ignore `builds`)
  still match by version alone. On those versions, roll back the `app` and `agent`
  components before a rebuild under the same number goes latest.

## Roll back

```bash
node scripts/live-updates/publish.mjs rollback --channel stable --component app
node scripts/live-updates/publish.mjs revoke --channel stable --id app-3.1.27-1a2b3c4d5e6f
```
Then upload. Each manifest is the channel's whole desired state: a component missing
from it means "run what the installed app ships". `revoke` also stops an id on
machines that already staged it.

## Rules

- Live updates only target the base builds they were made from. A user on an older
  full release gets the full update first.
- Sequences only go up; apps refuse older manifests. Publish from one place, or keep
  `vscode-live-updates/` in sync.
- Rotating the signing key means shipping the new public key in a full release before
  signing with it.
- Windows: `release-windows.yml` stamps the key from the `BACKBOARD_LIVE_UPDATE_PUBLIC_KEYS`
  repository variable (the `public-key.txt` value; optional
  `BACKBOARD_LIVE_UPDATE_MANIFEST_BASE_URL` / `BACKBOARD_LIVE_UPDATE_EVENTS_URL`). Without
  the variable, Windows builds ship with live updates off. Publish with
  `--platform win32 --arch x64` and the unpacked Windows app (`resources/app`) from the
  workflow's verified payload as `--base-app`; an app overlay also needs a Windows build
  as `--new-app`. The agent bundle can be published from a Mac (its smoke test only runs
  on the target OS). Not yet run on a real Windows machine.

## Test

Node only; no Electron test runner needed:
```bash
node --test scripts/live-updates/test/live-updates.e2e.test.mjs   # needs compiled out/ (dev.sh watch, or transpile-client)
npm run test-updater   # from backboard/extensions/backboard/, after tsgo --project ./tsconfig.json
npm run test-node -- --run src/vs/platform/backboardLiveUpdate/test/node/liveUpdate.test.ts   # from backboard/, Node 24, after transpile-client
```
