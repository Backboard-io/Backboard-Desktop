# Extension Points

## Public Extension Points

| Extension point | Defined in | Notes |
|---|---|---|
| Commands | `blueprint/06-extensions-marketplace.md`, `blueprint/09-input-command-keybindings.md` | Commands are registered through public API facade. |
| Views | `blueprint/05-rendering-ui.md`, `blueprint/06-extensions-marketplace.md` | Views contribute descriptors, not private widgets. |
| Languages | `blueprint/04-language-intelligence.md`, `blueprint/06-extensions-marketplace.md` | Language descriptors, grammars, and providers. |
| Debuggers | `blueprint/07-terminal-search-debug.md`, `blueprint/06-extensions-marketplace.md` | Debug adapters through contribution metadata. |
| Themes | `blueprint/05-rendering-ui.md` | Theme tokens and token colors. |
| File systems | `blueprint/03-files-workspaces.md` | URI scheme providers with declared capabilities. |

## Internal Extension Rule

Extensions never receive private service instances. Every capability crosses an API facade that validates arguments, checks permissions, handles cancellation, and converts internal models to stable public data records.

