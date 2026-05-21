# Backboard IDE Embedded CLI Next Steps

This document is retained as historical context only.

The Python ACP bridge and embedded-CLI runtime plan have been superseded. Backboard Studio now uses the Rust-native agent runtime:

- `ide/zed/crates/agent_servers/src/backboard.rs`
- `ide/zed/crates/agent_servers/src/backboard_native/`
- `ide/zed/crates/backboard/`

Do not reintroduce `ide/zed/script/backboard-ide-acp.py`, `BACKBOARD_CLI_ROOT`, or bundled Python CLI dependencies for active IDE chat. Packaging should ship the Rust app and native runtime metadata.
