---
"@runfusion/fusion": patch
---

summary: Fix first-boot SQLite migration failures while preserving all legacy project data.
category: fix
dev: Handles stale partitions, retired tables, derived FTS indexes, seeded singletons, and cross-database checksum collation.
