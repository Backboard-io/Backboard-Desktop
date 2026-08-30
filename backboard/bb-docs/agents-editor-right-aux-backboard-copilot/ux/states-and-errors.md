# Agents Editor Right Aux Backboard Copilot States And Errors

## State Matrix

| State | Backboard behavior | Copilot behavior | Auxiliary/editor behavior |
|---|---|---|---|
| Not authenticated | Backboard webview shows SSO overlay/status. | Copilot token or BYOK enablement gates registration/use. | Layout still renders; panel contents may be unavailable. |
| No browser editor | Screenshot action returns without work if no contextual browser view exists. | Not directly affected. | Browser auxiliary container may still be registered. |
| Run in progress | Backboard disables/changes composer actions, shows run clock, supports cancel. | Copilot session provider streams native chat content. | Editor and aux panel should not resize unexpectedly. |
| Auxiliary hidden | Backboard/details panel is hidden if it lives there. | Copilot native chat/editor can remain visible elsewhere. | Editor expands right. |
| Auxiliary restored | Last/default pane composite opens. | Copilot unchanged unless it owns a session editor. | Editor contracts to leave room. |
| Tool/subagent running | Backboard renders bridge tool progress in its webview. | Copilot formats tool/subagent invocations into native chat parts. | Layout remains stable. |

## Failure Boundaries

```text
Backboard failure boundaries
|-- OAuth/token/config file
|-- local bridge binary
|-- hosted Backboard API/model inventory
|-- tool execution and tool-output continuation
L-- webview message delivery

Copilot failure boundaries
|-- token/BYOK enablement
|-- chat participant/session provider registration
|-- Claude/Copilot CLI runtime availability
|-- worktree/session metadata
L-- tool/subagent trace and result formatting

Layout failure boundaries
|-- saved part sizes
|-- hidden/visible part state
|-- phone/tablet/desktop policy
L-- editor/auxiliary split resize
```
