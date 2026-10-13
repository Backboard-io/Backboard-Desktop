# Backboard Chat

Backboard Chat provides the in-editor assistant experience for Backboard IDE. It supports chat, inline edits, agent sessions, tool calls, workspace search, terminal assistance, and code-generation workflows.

## Agent Sessions

Use the Agents window to create, resume, and monitor coding sessions. Local sessions run through the Backboard agent host, while remote sessions can connect to configured remote agent hosts.

## Editor Chat

Use the right-side chat panel or inline editor chat to ask questions, edit selected code, generate files, run tools, and inspect workspace context. The visible product surface should use Backboard naming throughout.

## Authentication

Backboard authentication is handled by the Backboard SSO and API-key path wired into this repository. GitHub authentication should not be presented as the primary Backboard sign-in flow.

## Notes For Maintainers

This package still contains compatibility identifiers, paths, command IDs, and SDK references inherited from the upstream assistant integration. Do not rename those blindly. User-facing titles, descriptions, setup copy, panel labels, and docs should use Backboard terminology.
