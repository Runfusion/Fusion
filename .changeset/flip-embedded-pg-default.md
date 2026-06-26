---
"@runfusion/fusion": minor
---

summary: Default local backend is now embedded PostgreSQL; set FUSION_NO_EMBEDDED_PG=1 for legacy SQLite.
category: feature
dev: `createTaskStoreForBackend` now boots embedded PostgreSQL by default when DATABASE_URL is unset (previously required FUSION_EMBEDDED_PG=1). FUSION_EMBEDDED_PG=1 is now a no-op alias; FUSION_NO_EMBEDDED_PG=1 is the opt-out back to legacy SQLite. `embedded-postgres` is now a direct dependency of @runfusion/fusion so the bundled CLI can resolve the platform binary at runtime. Boot smoke exercises the embedded path by default (initdb-aware 180s health timeout). Also hardens three backend-mode gaps the flip exposed: ResearchStore/insights router/watch() now degrade gracefully instead of crashing `fn serve` when the sync SQLite satellite stores are unavailable in PG backend mode.
