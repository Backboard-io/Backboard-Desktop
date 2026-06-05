---
title: Uninstall
description: "This guide covers how to uninstall Backboard Studio on different operating systems."
---

# Uninstall

This guide covers how to uninstall Backboard Studio on different operating systems.

## macOS

### Standard Installation

If you installed Backboard Studio by downloading it from the website:

1. Quit Backboard Studio if it's running
2. Open Finder and go to your Applications folder
3. Drag Backboard Studio to the Trash (or right-click and select "Move to Trash")
4. Empty the Trash

### Homebrew Installation

If you installed Backboard Studio using Homebrew, use the following command:

```sh
brew uninstall --cask backboard
```

Or for the preview version:

```sh
brew uninstall --cask backboard@preview
```

### Removing User Data (Optional)

To completely remove all Backboard Studio configuration files and data:

1. Open Finder
2. Press `Cmd + Shift + G` to open "Go to Folder"
3. Delete the following directories if they exist:
   - `~/Library/Application Support/Backboard Studio`
   - `~/Library/Saved Application State/io.backboard.Studio.savedState`
   - `~/Library/Logs/Backboard Studio`
   - `~/Library/Caches/io.backboard.Studio`
   - `~/Library/Caches/Backboard Studio`
   - `~/.config/backboard`
   - `~/.local/state/Backboard Studio`

## Linux

### Standard Uninstall

If Backboard Studio was installed using the default installation script, run:

```sh
backboard --uninstall
```

You'll be prompted whether to keep or delete your preferences. After making a choice, you should see a message that Backboard Studio was successfully uninstalled.

If the `backboard` command is not found in your PATH, try:

```sh
$HOME/.local/bin/backboard --uninstall
```

or:

```sh
$HOME/.local/backboard.app/bin/backboard --uninstall
```

### Package Manager

If you installed Backboard Studio using a package manager (such as Flatpak, Snap, or a distribution-specific package manager), consult that package manager's documentation for uninstallation instructions.

### Manual Removal

If the uninstall command fails or Backboard Studio was installed to a custom location, you can manually remove:

- Installation directory: `~/.local/backboard.app` (or your custom installation path)
- Binary symlink: `~/.local/bin/backboard`
- Configuration and data: `~/.config/backboard`

## Windows

### Standard Installation

1. Quit Backboard Studio if it's running
2. Open Settings (Windows key + I)
3. Go to "Apps" > "Installed apps" (or "Apps & features" on Windows 10)
4. Search for "Backboard Studio"
5. Click the three dots menu next to Backboard Studio and select "Uninstall"
6. Follow the prompts to complete the uninstallation

Alternatively, you can:

1. Open the Start menu
2. Right-click on Backboard Studio
3. Select "Uninstall"

### Removing User Data (Optional)

To completely remove all Backboard Studio configuration files and data:

1. Press `Windows key + R` to open Run
2. Type `%APPDATA%` and press Enter
3. Delete the `Backboard Studio` folder if it exists
4. Press `Windows key + R` again, type `%LOCALAPPDATA%` and press Enter
5. Delete the `Backboard Studio` folder if it exists

## Troubleshooting

If you encounter issues during uninstallation:

- **macOS/Windows**: Ensure Backboard Studio is completely quit before attempting to uninstall. Check Activity Manager (macOS) or Task Manager (Windows) for any running Backboard Studio processes.
- **Linux**: If the uninstall script fails, check the error message and consider manual removal of the directories listed above.
- **All platforms**: If you want to start fresh while keeping Backboard Studio installed, you can delete the configuration directories instead of uninstalling the application entirely.

For additional help, see our [Linux-specific documentation](./linux.md) or visit the [Backboard Studio community](https://app.backboard.io/community-links).
