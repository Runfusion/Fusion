---
"@runfusion/fusion": patch
---

summary: Database maintenance now covers every project table, including plan-evidence and lifecycle tables.
category: fix
dev: 17 tables declared with `projectSchema.table(...)` were missing from `projectTableNames`, so health compaction skipped them and the PostgreSQL test harness never reset them between tests. `project-table-registry.test.ts` now fails when the schema and the registry drift apart.
