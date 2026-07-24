---
"@runfusion/fusion": patch
---

summary: Terminal no longer sticks on "Starting terminal..." on Windows and Ctrl/Cmd+V paste is delivered exactly once.
category: fix
dev: TerminalModal Cmd/Ctrl+V now calls preventDefault so the browser's native paste cannot double-deliver, and returns true (native xterm paste) when the async clipboard API is unavailable (non-HTTPS remote, older Firefox). useTerminalSessions exposes `autoCreateDisabled` (Windows browser clients) so the modal renders a "Start terminal" action instead of an endless spinner, and normalizes all-inactive persisted tab payloads on restore.
