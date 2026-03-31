---
"@dustinbyrne/kb": minor
---

Add stuck task detection and recovery. When `taskStuckTimeoutMs` is configured, tasks with stagnant agent sessions (no text, tool, or progress activity) are automatically terminated and retried from their current step.
