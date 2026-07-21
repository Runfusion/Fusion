---
"@runfusion/fusion": patch
---

summary: Stop PostgreSQL permission errors when the dashboard reads SQLite migration health.
category: fix
dev: Grants the project-bound runtime role row-scoped read access to the SQLite migration ledger.
