---
"@gsxdsm/fusion": patch
---

Fix terminal session creation error messages to return specific, actionable error messages instead of generic "Max sessions" message. Now returns distinct error codes (max_sessions, invalid_shell, pty_load_failed, pty_spawn_failed) with appropriate HTTP status codes.
