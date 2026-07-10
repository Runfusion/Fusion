---
"@runfusion/fusion": patch
---

summary: `fn task show`/`move` now retry through a momentarily locked board database instead of failing.
category: fix
dev: CLI-level bounded exponential backoff gated on SQLite lock errors (override via FUSION_CLI_LOCK_RETRY_MS); resolved TaskStore now closed for deterministic exit.
