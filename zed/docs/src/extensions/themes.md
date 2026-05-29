---
title: Themes
description: "Themes for Backboard Studio extensions."
---

# Themes

The `themes` directory in an extension should contain one or more theme files.

Each theme file should adhere to the JSON schema specified at [`https://app.backboard.io/schema/themes/v0.2.0.json`](https://app.backboard.io/schema/themes/v0.2.0.json).

See [this blog post](https://app.backboard.io/blog/user-themes-now-in-preview) for additional background on creating themes.

## Theme JSON Structure

The structure of a Backboard Studio theme is defined in the [Backboard Studio Theme JSON Schema](https://app.backboard.io/schema/themes/v0.2.0.json).

A Backboard Studio theme consists of a Theme Family object including:

- `name`: The name for the theme family
- `author`: The name of the author of the theme family
- `themes`: An array of Themes belonging to the theme family

The core components of a Theme object include:

1. Theme Metadata:

   - `name`: The name of the theme
   - `appearance`: Either "light" or "dark"

2. Style Properties under the `style`, such as:

   - `background`: The main background color
   - `foreground`: The main text color
   - `accent`: The accent color used for highlighting and emphasis

3. Syntax Highlighting:

   - `syntax`: An object containing color definitions for various syntax elements (e.g., keywords, strings, comments)

4. UI Elements:

   - Colors for various UI components such as:
     - `element.background`: Background color for UI elements
     - `border`: Border colors for different states (normal, focused, selected)
     - `text`: Text colors for different states (normal, muted, accent)

5. Editor-specific Colors:

   - Colors for editor-related elements such as:
     - `editor.background`: Editor background color
     - `editor.gutter`: Gutter colors
     - `editor.line_number`: Line number colors

6. Terminal Colors:
   - ANSI color definitions for the integrated terminal

## Designing Your Theme

You can use [Backboard Studio's Theme Builder](https://app.backboard.io/theme-builder) to design your own custom theme based on an existing one.

This tool lets you fine-tune and preview how surfaces in Backboard Studio will look.
You can then export the JSON and publish it in Backboard Studio's extension store.
