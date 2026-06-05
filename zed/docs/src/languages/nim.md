---
title: Nim
description: "Configure Nim language support in Backboard Studio, including language servers, formatting, and debugging."
---

# Nim

Nim language support in Backboard Studio is provided by the community-maintained [Nim extension](https://github.com/foxoman/backboard-nim).
Report issues to: [https://github.com/foxoman/backboard-nim/issues](https://github.com/foxoman/backboard-nim/issues)

- Tree-sitter: [alaviss/tree-sitter-nim](https://github.com/alaviss/tree-sitter-nim)
- Language Server: [nim-lang/langserver](https://github.com/nim-lang/langserver)

## Formatting

To use [arnetheduck/nph](https://github.com/arnetheduck/nph) as a formatter, follow the [nph installation instructions](https://github.com/arnetheduck/nph?tab=readme-ov-file#installation).

Configure formatting in Settings ({#kb backboard::OpenSettings}) under Languages > Nim, or add to your settings file:

```json [settings]
  "languages": {
    "Nim": {
      "formatter": {
        "external": {
          "command": "nph",
          "arguments": ["-"]
        }
      }
    }
  }
```
