# Backboard IDE Packaging Notes

This note explains why the development checkout is huge, why the downloadable app should be much smaller, and what needs to happen before Backboard Studio can be shipped as a normal web download.

## Development Build / Run Command

For day-to-day development on macOS, build and run the IDE from the Zed workspace. Replace `path/to/Espri-API` with wherever the repo is cloned on that machine.

```sh
cd path/to/Espri-API/ide/zed
cargo run -p zed
```

For a faster-to-test release-mode app without making a DMG:

```sh
cd path/to/Espri-API/ide/zed
cargo run -p zed --release
```

For Backboard inline autocomplete debugging:

```sh
cd path/to/Espri-API/ide/zed
BACKBOARD_API_KEY=your_key RUST_LOG=edit_prediction=debug cargo run -p zed
```

Useful targeted compile checks:

```sh
cd path/to/Espri-API/ide/zed
cargo check --locked -p agent_ui
cargo check --locked -p agent_ui -p agent_servers -p acp_thread
python3 -m py_compile script/backboard-ide-acp.py
```

### macOS Build Prerequisites

Install the full Xcode app, not only the command line tools. Zed/Backboard Studio needs Apple developer tools for shader compilation, linking, signing, and bundling.

1. Install Xcode from the Mac App Store or Apple Developer downloads.
2. Open Xcode once and let it install macOS platform components.
3. Point command line tools at the full Xcode install:

```sh
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
xcodebuild -runFirstLaunch
```

Install Rust and the active toolchain:

```sh
rustup update
rustup default stable
```

Install Node dependencies/tools needed by some bundle/documentation/release scripts:

```sh
node --version
npm --version
```

If `node` or `npm` is missing, install Node 20 or newer.

### Metal / Shader Compiler Fix

If builds or tests fail with a Metal shader compiler error, or an error like:

```txt
xcrun: error: unable to find utility "metal", not a developer tool or in PATH
```

First make sure Xcode is selected:

```sh
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
xcodebuild -runFirstLaunch
```

On macOS 26 or newer, install the Metal toolchain component:

```sh
xcodebuild -downloadComponent MetalToolchain
```

If that fails, run first-launch setup again and retry:

```sh
xcodebuild -runFirstLaunch
xcodebuild -downloadComponent MetalToolchain
```

Then clean and rebuild:

```sh
cd path/to/Espri-API/ide/zed
cargo clean
cargo run -p zed
```

### Common Dev Build Notes

- `cargo run -p zed` builds a debug app and can create a very large `target/debug` directory.
- `cargo run -p zed --release` is slower the first time but closer to the downloadable app behavior.
- `cargo check --locked -p agent_ui` is a good quick sanity check for most Backboard UI work.
- `cargo test -p agent_ui --no-fail-fast workspace_agent` may require the Metal toolchain before tests even start.
- The Python ACP bridge should still compile separately with `python3 -m py_compile script/backboard-ide-acp.py`.
- If the build gets weird after Xcode/Rust upgrades, try `cargo clean` and rebuild.

## Short Answer

The repo/build folder can be tens or hundreds of GB because Rust development builds create a large `target/` directory with incremental artifacts, debug symbols, dependency builds, and object files.

The downloadable app should be much smaller because users do not download:

- the git repo
- `.git/`
- Rust `target/`
- debug artifacts
- incremental compile cache
- test/build intermediates

Users should download only the packaged app artifact, such as a macOS `.dmg`, Windows installer, or Linux archive.

In this checkout, the measured size was:

```txt
30G   .
30G   ide/zed
30G   ide/zed/target
30G   ide/zed/target/debug
275M  .git
44M   cli
```

So almost all local disk usage came from:

```txt
ide/zed/target/debug
```

That is build cache, not something we should ship.

## What To Upload

Upload the release artifact, not the repository.

For macOS, the intended artifact is a DMG:

```txt
ide/zed/target/aarch64-apple-darwin/release/Zed-aarch64.dmg
ide/zed/target/x86_64-apple-darwin/release/Zed-x86_64.dmg
```

For Linux, the intended artifact is a compressed archive:

```txt
ide/zed/target/release/zed-linux-aarch64.tar.gz
ide/zed/target/release/zed-linux-x86_64.tar.gz
```

For Windows, the intended artifact is an installer/executable produced by the Windows bundle script.

## macOS Build Command

From:

```sh
cd ide/zed
```

Apple Silicon:

```sh
./script/bundle-mac aarch64-apple-darwin
```

Intel:

```sh
./script/bundle-mac x86_64-apple-darwin
```

The script builds release binaries, creates the `.app` bundle, then creates a compressed `.dmg`.

The upstream release workflow uses the same bundle script:

```txt
ide/zed/.github/workflows/release.yml
```

Relevant jobs:

- `bundle_mac_aarch64`
- `bundle_mac_x86_64`
- `bundle_linux_aarch64`
- `bundle_linux_x86_64`
- `bundle_windows_aarch64`
- `bundle_windows_x86_64`

## Why The DMG Is Smaller

A release DMG contains the runtime pieces needed to launch the app:

- final `zed` app binary
- app resources
- bundled CLI binary
- bundled git binary
- required metadata/plists/icons
- packaged remote server artifact where applicable

It does not contain the development build directory.

That is why a source checkout plus `target/` can be 30GB-120GB while a downloadable editor can be hundreds of MB.

## Backboard-Specific Packaging Catch

Backboard Studio is not only the Rust/Zed app. Our native Backboard agent path also depends on:

```txt
ide/zed/script/backboard-ide-acp.py
cli/backboard_cli/
```

During development, `BackboardAgentServer` resolves these from the repo layout:

```txt
ide/zed/script/backboard-ide-acp.py
ide/zed/../../cli
```

That works in a source checkout, but it will not automatically work in a packaged `.app` unless we intentionally bundle those files or require a separate installed CLI.

Before shipping a web download, choose one packaging strategy.

## Recommended Packaging Strategy

Bundle the Backboard ACP bridge and CLI runtime inside the app.

Recommended app layout:

```txt
Backboard Studio.app/
  Contents/
    MacOS/
      zed
      cli
      git
    Resources/
      backboard/
        backboard-ide-acp.py
        cli/
          backboard_cli/
          pyproject.toml
          ...
```

Then update the Rust bridge resolution so packaged builds look in app resources first:

1. Check `BACKBOARD_IDE_ACP_PATH` and `BACKBOARD_CLI_ROOT` env overrides.
2. Check packaged resource paths under `Contents/Resources/backboard/`.
3. Fall back to the development repo layout.

This preserves local development while making the downloaded app self-contained.

## Alternative Packaging Strategy

Require users to install the Backboard CLI separately.

In that model, the `.app` ships only the IDE and bridge launcher, then resolves:

```txt
~/.backboard/
~/.backboard/bin/backboard
~/.backboard/venv/bin/python
```

This makes the app bundle smaller but creates a worse first-run experience because the IDE agent can fail if the CLI is missing, outdated, or installed in a different location.

For a consumer-facing Backboard Studio download, bundled runtime is the safer default.

## Disk Cleanup For Local Development

To reclaim local space:

```sh
cd ide/zed
cargo clean
```

This removes `target/`, which frees most of the disk space. The tradeoff is that the next compile will rebuild dependencies and take longer.

Less aggressive cleanup:

```sh
cd ide/zed
rm -rf target/debug
```

This keeps other target outputs if present, but removes the main debug build directory.

Zed also includes a helper script:

```sh
cd ide/zed
./script/clear-target-dir-if-larger-than 350 200
```

The release workflow uses that style of cleanup in CI to keep runners from filling up.

## CI / Release Recommendation

Use CI or a dedicated build machine for release packaging.

Recommended flow:

1. Checkout repo on a clean builder.
2. Install Rust, Node, Xcode tools, and packaging dependencies.
3. Run the platform bundle script.
4. Upload only the generated `.dmg`, `.tar.gz`, or installer.
5. Do not upload `target/`.
6. Do not upload `.git/`.
7. Do not upload the full source checkout.

For macOS production releases, also handle:

- code signing
- entitlements
- notarization
- stapling
- branded app name/icon/bundle id
- update feed / release metadata

## Practical Next Tasks

Before Backboard Studio is downloadable from the web:

1. Rename/rebrand bundle metadata from Zed to Backboard Studio where required.
2. Decide whether to bundle the Python CLI runtime or depend on a separately installed CLI.
3. If bundling, copy `backboard-ide-acp.py` and `cli/backboard_cli` into app resources during `script/bundle-mac`.
4. Update `BackboardAgentServer` path resolution for packaged resource paths.
5. Build a release DMG locally.
6. Install it on a clean machine or clean user account.
7. Verify the app launches without the source repo present.
8. Verify Backboard chat can start, import the CLI runtime, read `~/.backboard/config.json`, and create an ACP session.
9. Verify Agent Workspace, file writes, terminal cards, and autocomplete still work.

The key test is simple:

```txt
If the source repo is deleted or moved, the packaged app should still launch and Backboard chat should still work.
```
