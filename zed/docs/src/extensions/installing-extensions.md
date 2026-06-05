---
title: Installing Extensions
description: "Browse, install, and manage extensions from the Backboard Studio Extension Gallery."
---

# Installing Extensions {#installing-extensions}

Extensions add functionality to Backboard Studio, including languages, themes, and AI tools. Browse and install them from the Extension Gallery.

Open the Extension Gallery with {#kb backboard::Extensions}, or select "Backboard Studio > Extensions" from the menu bar.

## Installation Location

- On macOS, extensions are installed in `~/Library/Application Support/Backboard Studio/extensions`.
- On Linux, they are installed in either `$XDG_DATA_HOME/backboard/extensions` or `~/.local/share/backboard/extensions`.
- On Windows, the directory is `%LOCALAPPDATA%\Backboard Studio\extensions`.

This directory contains two subdirectories:

- `installed`, which contains the source code for each extension.
- `work` which contains files created by the extension itself, such as downloaded language servers.

## Auto-installing

To automate extension installation/uninstallation see the docs for [auto_install_extensions](../reference/all-settings.md#auto-install-extensions).
