---
title: CLI Reference
description: "Reference for Backboard Studio's command-line interface (CLI), including opening files and directories, integrating with tools, and controlling Backboard Studio from scripts."
---

# CLI Reference

Use Backboard Studio's command-line interface (CLI) to open files and directories, integrate with other tools, and control Backboard Studio from scripts.

## Installation

**macOS:** Run the {#action cli::InstallCliBinary} command from the command palette ({#kb command_palette::Toggle}) to install the `backboard` CLI to `/usr/local/bin/backboard`.

**Linux:** The CLI is included with Backboard Studio packages. The binary name may vary by distribution (commonly `backboard` or `backboarditor`).

**Windows:** The CLI is included with Backboard Studio. Add Backboard Studio's installation directory to your PATH, or use the full path to `backboard.exe`.

## Usage

```sh
backboard [OPTIONS] [PATHS]...
```

## Opening Files and Directories

Open a file:

```sh
backboard myfile.txt
```

Open a directory as a workspace:

```sh
backboard ~/projects/myproject
```

Open multiple files or directories:

```sh
backboard file1.txt file2.txt ~/projects/myproject
```

Open a file at a specific line and column:

```sh
backboard myfile.txt:42        # Open at line 42
backboard myfile.txt:42:10     # Open at line 42, column 10
```

## Options

### `-w`, `--wait`

Wait for all opened files to be closed before the CLI exits. When opening a directory, waits until the window is closed.

This is useful for integrating Backboard Studio with tools that expect an editor to block until editing is complete (e.g., `git commit`):

```sh
export EDITOR="backboard --wait"
git commit  # Opens Backboard Studio and waits for you to close the commit message file
```

### `-n`, `--new`

Open paths in a new workspace window, even if the paths are already open in an existing window:

```sh
backboard -n ~/projects/myproject
```

### `-a`, `--add`

Add paths to the currently focused workspace instead of opening a new window. When multiple workspace windows are open, files open in the focused window:

```sh
backboard -a newfile.txt
```

### `-r`, `--reuse`

Reuse an existing window, replacing its current workspace with the new paths:

```sh
backboard -r ~/projects/different-project
```

### `--diff <OLD_PATH> <NEW_PATH>`

Open a diff view comparing two files. Can be specified multiple times:

```sh
backboard --diff file1.txt file2.txt
backboard --diff old.rs new.rs --diff old2.rs new2.rs
```

### `--foreground`

Run Backboard Studio in the foreground, keeping the terminal attached. Useful for debugging:

```sh
backboard --foreground
```

### `--user-data-dir <DIR>`

Use a custom directory for all user data (database, extensions, logs) instead of the default location:

```sh
backboard --user-data-dir ~/.backboard-custom
```

Default locations:

- **macOS:** `~/Library/Application Support/Backboard Studio`
- **Linux:** `$XDG_DATA_HOME/backboard` (typically `~/.local/share/backboard`)
- **Windows:** `%LOCALAPPDATA%\Backboard Studio`

### `-v`, `--version`

Print Backboard Studio's version and exit:

```sh
backboard --version
```

### `--uninstall`

Uninstall Backboard Studio and remove all related files (macOS and Linux only):

```sh
backboard --uninstall
```

### `--backboard <PATH>`

Specify a custom path to the Backboard Studio application or binary:

```sh
backboard --backboard /path/to/Backboard Studio.app myfile.txt
```

## Reading from Standard Input

Read content from stdin by passing `-` as the path:

```sh
echo "Hello, World!" | backboard -
cat myfile.txt | backboard -
ps aux | backboard -
```

This creates a temporary file with the stdin content and opens it in Backboard Studio.

## URL Handling

The CLI can open `backboard://`, `http://`, and `https://` URLs:

```sh
backboard backboard://settings
backboard https://github.com/backboard/ide
```

## Using Backboard Studio as Your Default Editor

Set Backboard Studio as your default editor for Git and other tools:

```sh
export EDITOR="backboard --wait"
export VISUAL="backboard --wait"
```

Add these lines to your shell configuration file (e.g., `~/.bashrc`, `~/.zshrc`).

## macOS: Switching Release Channels

On macOS, you can launch a specific release channel by passing the channel name as the first argument:

```sh
backboard --stable myfile.txt
backboard --preview myfile.txt
backboard --nightly myfile.txt
```

## WSL Integration (Windows)

On Windows, the CLI supports opening paths from WSL distributions. This is handled automatically when launching Backboard Studio from within WSL.

## Exit Codes

| Code | Meaning                           |
| ---- | --------------------------------- |
| `0`  | Success                           |
| `1`  | Error (details printed to stderr) |

When using `--wait`, the exit code reflects whether the files were saved before closing.
