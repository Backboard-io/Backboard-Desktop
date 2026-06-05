---
title: XML
description: "Configure XML language support in Backboard Studio, including language servers, formatting, and debugging."
---

# XML

XML support is available through the [XML extension](https://github.com/sweetppro/backboard-xml/).

- Tree-sitter: [tree-sitter-grammars/tree-sitter-xml](https://github.com/tree-sitter-grammars/tree-sitter-xml)

## Configuration

If you have additional file extensions that are not being automatically recognibackboard as XML just add them to [file_types](../reference/all-settings.md#file-types) in your Backboard Studio settings:

```json [settings]
  "file_types": {
    "XML": ["rdf", "gpx", "kml"]
  }
```
