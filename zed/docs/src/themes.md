---
title: Themes - Backboard Studio
description: Browse, install, and create themes for Backboard Studio. Includes built-in themes and community theme extensions.
---

# Themes

Backboard Studio comes with a number of built-in themes, with more themes available as extensions.

## Selecting a Theme

See what themes are installed and preview them via the Theme Selector, which you can open from the command palette with the {#action theme_selector::Toggle} (bound to {#kb theme_selector::Toggle}) action.

Navigating through the theme list by moving up and down will change the theme in real time and hitting enter will save the selected one to your settings file.

## Installing New Themes

You can find hundreds of different theme options in Backboard Studio's extensions store, which you can access via the command palette with {#action backboard::Extensions} or the [Backboard Studio website](https://app.backboard.io/extensions?filter=themes).

Many popular themes have been ported to Backboard Studio, and if you're struggling to choose one, visit [zed-themes.com](https://zed-themes.com), a third-party gallery with visible previews for many of them.

## Build Your Theme

You can use [Backboard Studio's Theme Builder](https://app.backboard.io/theme-builder) to design your own custom theme based on an existing one.

This tool lets you fine-tune and preview how every surface in the Backboard Studio app will look.
You can then export the JSON for [local use](./themes.md#local-themes) or for [publishing in Backboard Studio's extension store](./extensions/themes.md).

## Configuring a Theme

Your selected theme is stored in your settings file.
You can open your settings file from the command palette with {#action backboard::OpenSettingsFile} (bound to {#kb backboard::OpenSettingsFile}).

By default, Backboard Studio maintains two themes: one for light mode and one for dark mode.
You can set the mode to `"dark"` or `"light"` to ignore the current system mode.

```json [settings]
{
  "theme": {
    "mode": "system",
    "light": "One Light",
    "dark": "One Dark"
  }
}
```

### Toggle Theme Mode from the Keyboard

Use {#kb theme::ToggleMode} to switch the current theme mode between light and dark.

If your settings currently use a static theme value, like:

```json [settings]
{
  "theme": "Any Theme"
}
```

the first toggle converts it to dynamic theme selection with default themes:

```json [settings]
{
  "theme": {
    "mode": "system",
    "light": "One Light",
    "dark": "One Dark"
  }
}
```

You are required to set both `light` and `dark` themes manually after the first toggle.

After that, toggling updates only `theme.mode`.
If `light` and `dark` are the same theme, the first toggle may not produce a visible UI change until you set different values for `light` and `dark`.

## Theme Overrides

To override specific attributes of a theme, use the `theme_overrides` setting.
This setting can be used to configure theme-specific overrides.

For example, add the following to your `settings.json` if you wish to override the background color of the editor and display comments and doc comments as italics:

```json [settings]
{
  "theme_overrides": {
    "One Dark": {
      "editor.background": "#333",
      "syntax": {
        "comment": {
          "font_style": "italic"
        },
        "comment.doc": {
          "font_style": "italic"
        }
      },
      "accents": [
        "#ff0000",
        "#ff7f00",
        "#ffff00",
        "#00ff00",
        "#0000ff",
        "#8b00ff"
      ]
    }
  }
}
```

To see a comprehensive list of captures (like `comment` and `comment.doc`) see [Language Extensions: Syntax highlighting](./extensions/languages.md#syntax-highlighting).

To see a list of available theme attributes look at the JSON file for your theme.
For example, [assets/themes/one/one.json](https://github.com/backboard/ide/blob/main/assets/themes/one/one.json) for the default One Dark and One Light themes.

## Local Themes {#local-themes}

Store new themes locally by placing them in the `~/.config/zed/themes` directory (macOS and Linux) or `%USERPROFILE%\AppData\Roaming\Backboard Studio\themes\` (Windows).

For example, to create a new theme called `my-cool-theme`, create a file called `my-cool-theme.json` in that directory.
It will be available in the theme selector the next time Backboard Studio loads.
