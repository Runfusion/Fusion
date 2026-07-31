---
"@runfusion/fusion": patch
---

summary: Remove the unused cross-project concurrency table from the central database.
category: internal
dev: Migration 0037 drops `central.global_concurrency`. Nothing read it after the cap was removed: `global_max_concurrent` held the deleted machine-wide limit, and `currently_active`/`queued_count` were maintained only by `acquireGlobalSlot`/`releaseGlobalSlot`, which had no production caller. `SCHEMA_BASELINE_VERSION` advances to 0037 and the migration is explicitly registered in `schema-applier.ts` (migrations are not auto-discovered). The historical 0000 baseline is left untouched, so a fresh database creates the table and then drops it, converging with upgraded databases. Live cross-project telemetry is unaffected — it comes from `CentralCore.getLiveRunningAgentCounts`.
