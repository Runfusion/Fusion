---
"@runfusion/fusion": patch
---

summary: Fix a dashboard/app boot crash on databases created before the bulk-completion-refusal change.
category: fix
dev: PR #2260 added project.tasks.bulk_completion_refusal_at to the Drizzle model and the 0000 baseline but shipped no forward migration, so any pre-existing PostgreSQL database (already carrying the 0000 marker) never gained the column and crashed on the first TaskStore SELECT. Adds forward migration 0018 (wired via BULK_COMPLETION_REFUSAL_AT_VERSION, SCHEMA_BASELINE_VERSION → "0018"), a per-column upgrade regression test, and a migration-wiring-integrity guard (baseline marker must equal the highest migration file; every .sql must be registered).
