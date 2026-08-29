---
"@runfusion/fusion": patch
---

summary: Fix a startup crash where Fusion rejected the database it had just migrated.
category: fix
dev: FN-149 shipped migration `0065_fn_149_review_convergence_stage.sql` without advancing `SCHEMA_BASELINE_VERSION` (still `"0064"`), so the first store open applied and recorded 0065 and the next open threw `StaleBinarySchemaError` from `assertBinaryNotOlderThanDatabase` ("this binary only knows up to 0064"), exiting 1 on fresh and upgraded databases alike. Bumps the ceiling to `"0065"` (marker only — applies no SQL, touches no data) and moves the DB-free migration-wiring assertions to `packages/core/src/__tests__/migration-wiring-integrity.test.ts`, now wired into `test:unit-gate` so a migration landing without a ceiling bump fails the merge gate.
