---
"@runfusion/fusion": patch
---

summary: Recover stale executor sessions with bounded fresh-session retries while preserving task progress.
category: fix
dev: Clears the persisted assistant-last transcript, defers requeue until lock release, and exhausts through the shared recovery budget.
