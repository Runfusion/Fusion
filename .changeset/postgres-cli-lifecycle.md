---
"@runfusion/fusion": patch
---

summary: Ensure PostgreSQL-backed CLI commands release project resources before exiting.
category: fix
dev: Rebases the CLI cutover onto the merged core/runtime stack and makes factory shutdown ownership explicit.
