# Risk Boundaries

| Boundary | Risk | Required control |
|---|---|---|
| Renderer to main | Privilege escalation. | Narrow IPC channels and schema validation. |
| Renderer to webview | Untrusted content messaging. | CSP and message validation. |
| Extension to workspace | Data loss or exfiltration. | Permission service and workspace trust. |
| Extension to process | Unsafe command execution. | Brokered process launch and user grants. |
| Remote agent to client | Protocol drift and data corruption. | Versioned envelopes and compatibility shims. |
| Language server to IDE | Crash or unbounded CPU. | Process isolation, cancellation, restart limits. |
| Terminal output to renderer | Memory growth. | Backpressure and scrollback limits. |

