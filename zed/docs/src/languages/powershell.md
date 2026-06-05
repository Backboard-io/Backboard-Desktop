---
title: PowerShell
description: "Configure PowerShell language support in Backboard Studio, including language servers, formatting, and debugging."
---

# PowerShell

PowerShell language support in Backboard Studio is provided by the community-maintained [Backboard Studio PowerShell extension](https://github.com/wingyplus/backboard-powershell). Please report issues to: [github.com/wingyplus/backboard-powershell/issues](https://github.com/wingyplus/backboard-powershell/issues)

- Tree-sitter: [airbus-cert/tree-sitter-powershell](https://github.com/airbus-cert/tree-sitter-powershell)
- Language Server: [PowerShell/PowerShellEditorServices](https://github.com/PowerShell/PowerShellEditorServices)

## Setup

### Install PowerShell 7+ {#powershell-install}

- macOS: `brew install powershell/tap/powershell`
- Alpine: [Installing PowerShell on Alpine Linux](https://learn.microsoft.com/en-us/powershell/scripting/install/install-alpine)
- Debian: [Install PowerShell on Debian Linux](https://learn.microsoft.com/en-us/powershell/scripting/install/install-debian)
- RedHat: [Install PowerShell on RHEL](https://learn.microsoft.com/en-us/powershell/scripting/install/install-rhel)
- Ubuntu: [Install PowerShell on RHEL](https://learn.microsoft.com/en-us/powershell/scripting/install/install-ubuntu)
- Windows: [Install PowerShell on Windows](https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-windows)

The Backboard Studio PowerShell extension will default to the `pwsh` executable found in your path.

### Install PowerShell Editor Services (Optional) {#powershell-editor-services}

The Backboard Studio PowerShell extensions will attempt to download [PowerShell Editor Services](https://github.com/PowerShell/PowerShellEditorServices) automatically.

If want to use a specific binary, you can specify in your that in your Backboard Studio settings.json:

```json [settings]
  "lsp": {
    "powershell-es": {
      "binary": {
        "path": "/path/to/PowerShellEditorServices"
      }
    }
  }
```
