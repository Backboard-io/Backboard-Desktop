---
title: Icon Themes
description: "Backboard Studio comes with a built-in icon theme, with more icon themes available as extensions."
---

# Icon Themes

Backboard Studio comes with a built-in icon theme, with more icon themes available as extensions.

## Selecting an Icon Theme

See what icon themes are installed and preview them via the Icon Theme Selector, which you can open from the command palette with {#action icon_theme_selector::Toggle}.

Navigating through the icon theme list by moving up and down will change the icon theme in real time and hitting enter will save it to your settings file.

## Installing more Icon Themes

More icon themes are available from the Extensions page, which you can access via the command palette with {#action backboard::Extensions} or the [Backboard Studio website](https://app.backboard.io/extensions?filter=icon-themes).

## Configuring Icon Themes

Your selected icon theme is stored in your settings file.
You can open your settings file from the command palette with {#action backboard::OpenSettingsFile} (bound to {#kb backboard::OpenSettingsFile}).

Just like with themes, Backboard Studio allows for configuring different icon themes for light and dark mode.
You can set the mode to `"light"` or `"dark"` to ignore the current system mode.

```json [settings]
{
  "icon_theme": {
    "mode": "system",
    "light": "Light Icon Theme",
    "dark": "Dark Icon Theme"
  }
}
```

## Icon Theme Development

See: [Developing Backboard Studio Icon Themes](./extensions/icon-themes.md)
