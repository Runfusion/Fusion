---
category: test-failures
module: testing
problem_type: PostgreSQL fixture cleanup and DDL contention
applies_when: Engine reliability tests create isolated PostgreSQL databases under loaded worker fan-out.
tags: [postgresql, testing, reliability, ddl, cleanup]
---

# PostgreSQL reliability helper DDL audit

FN-9133 audited `packages/engine/src/__tests__/reliability-interactions/_helpers.ts`, the contained PostgreSQL fixture helper used by the engine reliability lane.

## Inventory

Before the fix, each fixture used `psql ... -f -` for all database DDL, issued a redundant unique-name `DROP DATABASE IF EXISTS` before `CREATE DATABASE`, and used a best-effort cleanup drop without `WITH (FORCE)`. That was three explicit database statements per fixture (drop/create/drop), plus a full schema baseline. The helper's runtime pool permits five connections, so a live connection could make the cleanup drop fail and leave a `fusion_rel_%` database.

The audit's source census found 53 `makeReliabilityFixture(`, 3 `makePgTaskStore(`, and 3 `createPgLayer(` occurrences (including declarations) in this checkout. A repository scan for `CREATE DATABASE` across engine, dashboard, and CLI sources returned only this helper, so the divergence was contained.

## Measurements

Each measurement ran `engine-reliability` with retained output, then queried `pg_database` for `fusion_rel_%` and used `pgrep -x psql` for the child census.

| phase/run | workers | result | wall seconds | leaked databases | live psql |
|---|---|---|---:|---:|---:|
| baseline default | computed default | 100 files / 548 tests passed | 52.85 | 1 | 0 |
| baseline elevated 1 | 12 | passed | 38.62 | 0 | 0 |
| baseline elevated 2 | 12 | passed | 35.20 | 0 | 0 |
| post default | computed default | passed | 49.01 | 0 | 0 |
| post elevated 1 | 12 | passed | 45.77 | 0 | 0 |
| post elevated 2 | 12 | passed | 48.71 | 0 | 0 |

Baseline variation was 35.20/38.62/52.85 seconds (min/median/max); post-change variation was 45.77/48.71/49.01. This is not a timing-improvement claim. The acceptance band was three green post-change runs, zero database leaks, zero psql children, and no run slower than the 52.85-second baseline maximum; all runs met it.

## Verdict

### Admission/deferred drain: do not copy

FN-9130 measured uniform and drop-only K=4 in-hook admission as regressions, with unstable watchdog counts even on unchanged ungated code. FN-9133 therefore does **not** add an advisory admission gate or deferred drain. FN-9134 owns the open structural alternative.

### Maintenance-connection contract: conform

The helper now uses a short-lived owned `postgres.js` maintenance client with a server-side statement timeout, a JavaScript deadline, and forced socket close. It no longer needs a `psql` binary gate. Cleanup uses `DROP DATABASE IF EXISTS ... WITH (FORCE)`, and the redundant pre-create drop is removed; the explicit DDL minimum is now create plus forced cleanup drop.

The regression test holds an independent open transaction, runs helper cleanup, verifies that `pg_database` no longer contains the fixture, and calls cleanup twice. A temporary local revert failed the test with the retained `fusion_rel_74100_1_dobb29` database. The test also pins the absence of `exec`, `execSync`, or `spawnSync` psql DDL launch sites.

## Policy preservation

No test or hook timeout, worker/fan-out setting, `exclude`, retry, `.skip` policy (other than the standard `hasPg` conditional test gate), or quarantine ledger changed. The changed lane, targeted contract test, lint, `pnpm verify:fast`, and `pnpm build` passed.
