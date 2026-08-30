# UI Screen Map

## System -> UI Rendering -> Screen Surfaces

```text
+--------------------------------------------------------------------------------------------------+
| Title Bar / Command Center / Window Controls                                                     |
+------------+----------------------+--------------------------------------------------------------+
| Activity   | Sidebar              | Editor Groups                                                |
| Bar        | Explorer/Search/SCM   | +------------------------+ +-------------------------------+ |
|            | Debug/Extensions      | | Editor Tab Stack       | | Split Editor Tab Stack        | |
|            | Contributed Views     | | Code/Diff/Notebook     | | Code/Webview/Custom Editor    | |
+------------+----------------------+--------------------------------------------------------------+
| Panel: Terminal | Problems | Output | Debug Console | Search Results | Tasks                           |
+--------------------------------------------------------------------------------------------------+
| Status Bar: branch, errors, language, encoding, cursor, background jobs, extension status          |
+--------------------------------------------------------------------------------------------------+
```

## Behavior

- Every visible command surface is backed by the command registry.
- Every view has a stable ID and a serialized restore state.
- Every virtualized list exposes keyboard navigation and accessibility metadata.
- Every extension-contributed UI surface is mediated by registered contribution points.

