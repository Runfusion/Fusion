---
"@runfusion/fusion": patch
---

summary: Prevent transient dashboard failures when multiple projects initialize PostgreSQL concurrently.
category: fix
dev: Uses one advisory-lock order for schema DDL, SQLite cutover, and project identity promotion.
