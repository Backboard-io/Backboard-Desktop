# States And Errors

| State | UI behavior | System behavior |
|---|---|---|
| Loading workspace | Shell visible, progress in status and explorer. | Restore storage, scan roots, defer extensions. |
| Extension host crashed | Views remain, extension-owned providers marked unavailable. | Restart once, then disable repeated crash owner. |
| Remote disconnected | Remote editors read-only, terminals paused. | Reconnect with backoff and preserve local UI state. |
| Large file mode | Badge and disabled high-cost features. | Chunked reads, viewport rendering, bounded edits. |
| Corrupted storage | Recovery notification. | Quarantine DB, start clean, restore backups. |
| File watcher overflow | Index refresh indicator. | Rescan affected roots and invalidate stale search data. |
| Language server failed | Language status error and logs. | Stop restart loop after threshold. |
| Terminal backpressure | Terminal remains interactive with reduced scrollback. | Throttle chunks and trim buffers. |

