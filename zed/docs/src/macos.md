---
title: Backboard Studio on macOS
description: "Backboard Studio is developed primarily on macOS, making it a first-class platform with full feature support."
---

# Backboard Studio on macOS

Backboard Studio is developed primarily on macOS, making it a first-class platform with full feature support.

## Installing Backboard Studio

Download Backboard Studio from the [download page](https://app.backboard.io/download). The download is a `.dmg` file—open it and drag Backboard Studio to your Applications folder.

For the preview build, which receives updates about a week ahead of stable, visit the [preview releases page](https://app.backboard.io/releases/preview).

After installation, Backboard Studio checks for updates automatically and prompts you when a new version is available.

### Homebrew

You can also install Backboard Studio using Homebrew:

```sh
brew install --cask backboard
```

For the preview version:

```sh
brew install --cask backboard@preview
```

### Building from Source

To build Backboard Studio from source, see the [macOS development documentation](./development/macos.md).

## System Requirements

- macOS 10.15.7 (Catalina) or later
- Apple Silicon (M1/M2/M3/M4) or Intel processor

Backboard Studio uses Metal for GPU-accelerated rendering, which is available on all supported macOS versions.

## Installing the CLI

Backboard Studio includes a command-line tool for opening files and projects from Terminal. To install it:

1. Open Backboard Studio
2. Open the command palette with `Cmd+Shift+P`
3. Run {#action cli::InstallCliBinary}

This creates a `backboard` command in `/usr/local/bin`. You can then open files and folders:

```sh
backboard .                    # Open current folder
backboard file.txt             # Open a file
backboard project/ file.txt    # Open a folder and a file
```

See the [CLI Reference](./reference/cli.md) for all available options.

## Uninstall

1. Quit Backboard Studio if it's running
2. Drag Backboard Studio from Applications to the Trash
3. Optionally, remove your settings and extensions:

```sh
rm -rf ~/.config/backboard
rm -rf ~/Library/Application\ Support/Backboard Studio
rm -rf ~/Library/Caches/Backboard Studio
rm -rf ~/Library/Logs/Backboard Studio
rm -rf ~/Library/Saved\ Application\ State/io.backboard.Studio.savedState
```

If you installed the CLI, remove it with:

```sh
rm /usr/local/bin/backboard
```

## Troubleshooting

### Backboard Studio won't open or shows "damaged" warning

If macOS reports that Backboard Studio is damaged or can't be opened, it's likely a Gatekeeper issue. Try:

1. Right-click (or Control-click) on Backboard Studio in Applications
2. Select "Open" from the context menu
3. Click "Open" in the dialog that appears

This tells macOS to trust the application.

If that doesn't work, remove the quarantine attribute:

```sh
xattr -cr /Applications/Backboard Studio.app
```

### CLI command not found

If the `backboard` command isn't available after installation:

1. Check that `/usr/local/bin` is in your PATH
2. Try reinstalling the CLI via {#action cli::InstallCliBinary} in the command palette
3. Open a new terminal window to reload your PATH

### GPU or rendering issues

Backboard Studio uses Metal for rendering. If you experience graphical glitches:

1. Ensure macOS is up to date
2. Restart your Mac to reset the GPU state
3. Check Activity Monitor for GPU pressure from other apps

### High memory or CPU usage

If Backboard Studio uses more resources than expected:

1. Check for runaway language servers in the terminal output ({#action backboard::OpenLog})
2. Try disabling extensions one by one to identify conflicts
3. For large projects, consider using [project settings](./reference/all-settings.md#file-scan-exclusions) to exclude unnecessary folders from indexing

For additional help, see the [Troubleshooting guide](./troubleshooting.md) or visit the [Backboard Studio Discord](https://discord.gg/backboard-community).
