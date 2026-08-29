# Code Review — SQLite → PostgreSQL Storage Migration

> **Historical review:** This document records the incomplete migration branch as reviewed on 2026-06-26. Its NOT READY verdict and line-specific findings are not the current cutover status. See the [2026-07-14 PostgreSQL runtime cutover review](./postgres-migration-review-2026-07-14.md) for the audited current architecture, residual legacy-reader inventory, and deployment contract.

**Date:** 2026-06-26
**Branch:** `feature/postgres` reviewed against `origin/main` (merge-base `7d13f880b`)
**HEAD:** `387cec1a7` — `feat: migrate storage from SQLite to PostgreSQL (squash)`
**Reviewers:** 13 persona agents (ce-code-review multi-agent pipeline) + learnings researcher + deployment verification
**Run artifacts:** `/tmp/compound-engineering/ce-code-review/20260626-084137-41a91d02/` (per-reviewer JSON)
**Plan:** `docs/plans/2026-06-23-001-feat-migrate-sqlite-to-postgres-plan.md`

---

## Scope

- 714 files changed, **+64,470 / −173,769**.
- **42,858 lines** of new code under `packages/core/src/postgres/`, `packages/core/src/task-store/` (63 files), and 19 `async-*` satellite stores.
- **388 deleted test files** (167 core, 123 dashboard, 73 engine, plugins); 53 new `__tests__/postgres/*.pg.test.ts` added; `scripts/lib/test-quarantine.json` +175 lines.

## Verdict: **NOT READY TO MERGE**

A well-architected migration that honors the plan's design (R1–R12 are all honored in *design*), but as a single 42k-line squash it ships with **7 P0 and ~27 P1 findings**. Three structural facts dominate:

1. **The async rewrite repeatedly dropped guards the sync path still enforces.** Soft-delete write-conflict guards, handoff atomicity, and — most severely — entire merge-critical store methods were never given a `backendMode` branch, so they **throw on every merge in the default embedded-PG backend**.
2. **The tests that protected those invariants were deleted, and the new PG tests do not run in CI.** No Postgres service is provisioned and the skip logic is inverted, so 42k lines of new data-layer code is effectively uncovered. This is the FN-5893 "deleted the repro, kept the bug" failure mode.
3. **This is a mid-migration (dual-path) branch, not post-cutover.** Both SQLite and Postgres paths are live behind **289 `backendMode` branches**; R11 (SQLite removed) is intentionally incomplete. The unguarded methods below are un-migrated leftovers of an incomplete flip.

The backup subsystem is independently broken three ways in the default embedded mode, and there is no first-class migration entry point.

---

## P0 — Critical (must fix before merge)

| # | File:Line | Issue | Reviewer(s) | Conf |
|---|-----------|-------|-------------|------|
| 1 | `task-store/remaining-ops-6.ts:441` | **`getActiveMergingTask` throws in PG mode.** Calls `store.db.prepare(...)` with no `backendMode` guard; the `db` getter throws *"SQLite Database is not available in backend mode"*. The merge concurrency guard (callers `merger.ts:9755`, `project-engine.ts:2247`) fails on every merge. **Verified.** | api-contract | 100 |
| 2 | `task-store/remaining-ops-6.ts:818` | **`upsertMergeRequestRecord` throws in PG mode** — unguarded `store.db`. Callers `merger.ts:8466`, `executor.ts:1970`, `self-healing.ts:828`, `project-engine.ts:1866`. Method must become async + all callsites awaited. | api-contract | 100 |
| 3 | `task-store/remaining-ops-6.ts:845` | **`transitionMergeRequestState` throws in PG mode** — unguarded `store.db`. ~12 callers in `merger.ts`/`project-engine.ts`. The merge state machine cannot advance. | api-contract | 100 |
| 4 | `.github/workflows/full-suite.yml` · `__test-utils__/pg-test-harness.ts:81` | **New PG tests don't run in CI.** No `postgres` service is provisioned and `PG_AVAILABLE` is always truthy (`PG_TEST_URL_BASE` defaults non-empty, `FUSION_PG_TEST_SKIP` never set), so the 57 `pgDescribe` suites fail with `ECONNREFUSED` or are dead. 42k lines of new data-layer code has no integration coverage in CI. | testing | 100 |
| 5 | `postgres/pg-backup.ts:261` | **`pg_dump` connects to the wrong DB.** Connection string passed via `PG_CONNECTION_STRING` — not a libpq variable. With no `--dbname`/`PG*` vars it hits the system default (localhost:5432, current user); in embedded mode (random port) backups fail or target an empty DB. The FNXC comment documents the (good) intent but the env var is non-functional. **Verified.** | reliability | 100 |
| 6 | `postgres/pg-backup.ts:302` | Same gap for **`pg_restore`** — restore targets the wrong server. **Verified.** | reliability | 100 |
| 7 | `task-store/remaining-ops-1.ts:132` | **Soft-delete resurrection.** The `backendMode` branch of `atomicWriteTaskJsonWithAudit` blind-upserts the row with no `deletedAt` re-read and no `throwSoftDeletedWriteBlocked` — the guard the sync branch has (lines 144-167). A write to / racing a soft-deleted task silently resurrects it (R7 / VAL-DATA-005/006). **Verified the guard is absent.** | adversarial (corrob. correctness, learnings, testing) | 75 |

> Note: #1–#3 and #7 are the same root cause as the structural P1 below (#13) — an incomplete sync→async flip — manifesting as hard runtime failures and data-integrity regressions on critical paths.

---

## P1 — High

### Unguarded `store.db` on async-converted paths (all throw in PG mode, confidence 100, `api-contract`)
| # | File:Line | Method / impact |
|---|-----------|-----------------|
| 8 | `task-store/remaining-ops-2.ts:438` | `renewCheckoutLeaseImpl` — checkout lease renewal throws; silently escalates to checkout expiry during active execution. |
| 9 | `task-store/remaining-ops-2.ts:871` | `registerArtifactImpl` — preliminary taskId check at :871 sits *outside* the `register()` guard at :890; throws whenever `input.taskId` is set. |
| 10 | `task-store/remaining-ops-6.ts:618, :662, :699` · `remaining-ops-2.ts:489, :509` · `workflow-ops.ts:24` | Workflow settings read/write (×6) + workflow-step creation — engine agent-tools and dashboard workflow/settings routes throw in PG mode. |
| 11 | `task-store/remaining-ops-6.ts:460` | `findRecentTasksByContentFingerprint` — unguarded **and** uses SQLite-only `json_extract(...)`; near-duplicate intake breaks. |

### Other P1
| # | File:Line | Issue | Reviewer(s) | Conf |
|---|-----------|-------|-------------|------|
| 12 | `task-store/moves.ts:187, :702` | **Handoff-to-review atomicity broken.** `createCompletionHandoffWorkflowWork` runs its workflow-work cancel/upsert in their own fresh-pool transactions, not the outer handoff `tx`; an outer rollback leaves committed workflow-work / orphaned merge-gate rows (R7 mergeQueue invariant). Pool-exhaustion deadlock risk via nested `transactionImmediate` (`workflow-workitems-ops-2.ts:20`). | correctness | 75 |
| 13 | `store.ts` (289 sites) | **The flip never completed.** 19 `async-*` stores added *alongside* unchanged sync stores with 289 `backendMode` branches; `agent-store.ts` (3202 L), `mission-store.ts` (4390 L), `central-core.ts` (4374 L) carry both paths. Every feature written twice; the SQLite-fallback path (`in-process-runtime.ts:239`, `asyncLayer` null) runs untested. Root cause of #1–#3, #7–#11. | maintainability (corrob. correctness, testing) | 100 |
| 14 | `postgres/sqlite-migrator.ts:369` | **Migration data-corruption risk.** `resolveColumnMapping` joins `information_schema.columns` by column name only (no table predicate); `data` is `text` in `archived_tasks` but `jsonb` in 5+ tables → nondeterministic type classification → batch aborts on `::jsonb` mismatch. Fixtures pass, prod fails. | data-migration | 75 |
| 15 | `postgres/sqlite-migrator.ts:596` | **Content-blind verification.** `targetRows >= sourceRows` with `ON CONFLICT DO NOTHING` cannot detect under-migration or content divergence on re-run; reports `verified` regardless. | data-migration + adversarial (agree) | 100 |
| 16 | `dashboard/routes/register-signal-routes.ts:222` | `resolveIncident()` became async but the caller was not updated — **floating Promise**, incident-resolution errors silently dropped. | api-contract | 100 |
| 17 | `dashboard/monitor-store.ts:170` | **Broken backend discriminator.** `'transactionImmediate' in db` always routes SQLite `Database` instances (which also expose `transactionImmediate`, `db.ts:5746`) to the async path → `resolveIncidentAsync` runs with a `DatabaseSync` as the Drizzle arg. | api-contract | 75 |
| 18 | `postgres/migrations/0000_initial.sql:1436` | **Missing index on `source_parent_task_id`** → the lineage gate (`findLiveLineageChildren`/`removeLineageReferences`, run on every archive/delete) is a full `tasks`-table scan. | performance | 100 |
| 19 | `task-store/async-merge-coordination.ts:255` | **N+1 in merge-queue lease acquire** — 2 round-trips per stale row inside the tx, on every merge attempt (20 stale rows = 40 sequential round-trips before the first lease). | performance | 100 |
| 20 | `task-store/async-audit.ts:120, :252` | **`LIMIT` applied in JS, not SQL** — audit/activity queries pull the entire matching set then `.slice()`; `activity_log` has no rotation. | performance | 100 |
| 21 | `task-store/async-persistence.ts:280` | `readLiveTaskRows` does an unbounded `SELECT * FROM tasks WHERE deleted_at IS NULL` (80+ cols, jsonb) on every board hydration — MB/request over the wire. | performance | 100 |
| 22 | `postgres/credential-redact.ts:39` | Redaction misses `?password=` query-param URLs; logged verbatim by `DatabaseConnectionError`/`describeBackendForLog`. | security | 75 |
| 23 | `postgres/embedded-lifecycle.ts:414` | SIGTERM/SIGINT handler `await this.stop()` but never re-raises → process hangs alive until SIGKILL after the cluster stops. | reliability | 100 |
| 24 | `postgres/startup-factory.ts:292` | No timeout on `embeddedLifecycle.start()` — a stalled `initdb`/`pg_ctl` hangs startup forever. | reliability | 75 |
| 25 | `postgres/pg-backup.ts:130` | Partial backup not cleaned up — central dump failure orphans the project dump; `listBackups()` counts it as a pair, skewing retention. | reliability | 75 |
| 26 | `postgres/pg-backup.ts` (packaging) | **Backup broken end-to-end in embedded mode**: `pg_dump`/`pg_restore` not bundled with `@embedded-postgres/*` (only `initdb`/`pg_ctl`/`postgres`); `BackupManager` also throws standalone because the embedded URL resolves only at daemon start. Compounds #5/#6. | deployment + agent-native (agree) | 100 |
| 27 | `cli/src/commands/db.ts` | **No `fn db migrate` command and no auto-migrate at startup.** First boot on the new embedded-PG default produces an *empty database*; existing SQLite data is invisible until a hand-written script runs `migrateSqliteToPostgres`. Silent data-loss trap. | agent-native + deployment (agree) | 100 |
| 28 | `__tests__/postgres/create-task-reserved-id.pg.test.ts` | `TombstonedTaskResurrectionError` (FN-5208/FN-5233, an AGENTS.md repeat-regression incident) has zero PG coverage; 13 engine reliability-interaction tests + `soft-delete-stickiness-FN-5233.test.ts` deleted (they used the removed `inMemoryDb` option, not deleted code). This is the test that would catch #7. | testing | 100 |
| 29 | `async-central-core.ts:1424+` | FNXC gap: 1789-line file, 3 FNXC comments; the concurrency-slot + mesh-state sections (the "important technical decisions" AGENTS.md requires marked) are unmarked. | project-standards | 75 |
| 30 | `task-store/remaining-ops-1.ts`…`-10.ts` | `remaining-ops-1..10` (~9000 L) are explicitly un-categorized overflow modules (mixed domains, several >1000 L); `lifecycle-ops.ts` is a new 1241-line file mixing DB open, FS watching, and settings migration. | maintainability | 100 |

---

## P2 — Moderate

- `moves.ts:626` — soft-delete guard also missing on `moveTaskInternal` backend path (sibling of #7). *(adversarial, 50)*
- `moves.ts:629` — WIP capacity limit overrun: two concurrent backend moves into one slot both commit under READ COMMITTED. *(adversarial, 50)*
- `task-store/audit-ops.ts:59` — `taskRow as unknown as TaskDetail` **bypasses deserialization**; hook consumers get raw JSON-string columns. *(maintainability, 100)*
- `postgres/connection.ts:46` — default pool `max=10` may starve under `maxWorktrees`-level concurrent `transactionImmediate` holders. *(performance, 75)*
- `postgres/postgres-health.ts:329` — `healSchemaDrift` `catch {}` swallows ALTER TABLE errors silently. *(reliability, 100; safe_auto)*
- `postgres-health.ts:354/389` — `validateAndHealSchema` ALTER and `vacuumAnalyze` VACUUM run on the runtime pool, not the migration connection → fail under a transaction-mode pooler.
- `sqlite-migrator.ts:471` — empty-string → NULL for `jsonb`; `NOT NULL jsonb` columns (`data`/`ir`/`step_ids`) abort the batch on legacy `''` rows. *(data-migration)*
- `__test-utils__/pg-test-harness.ts:128` — `execSync('psql …')` violates the AGENTS.md execSync ban (not git plumbing; no timeout → can hang the vitest worker). *(project-standards)*
- `0000_initial.sql:1425` — no partial index for the hot `WHERE deleted_at IS NULL AND column = ?` kanban read (forces bitmap-AND). *(performance)*
- **9 quarantine entries are migration-caused mock drift, not flakes** (CE orchestrator, desktop `local-server`, dashboard `research-api`) — AGENTS.md forbids quarantining tests that fail *because of* the change; 14-day deletion clock expires **2026-07-09**. *(testing)*
- `index.ts` — `detectLegacyData`/`migrateFromLegacy`/`getMigrationStatus` removed from the `@fusion/core` public index with no deprecation; `dist/index.d.ts` still referenced them. *(api-contract)*
- `store.ts:389` / `plugin-store.ts:130` — `inMemoryDb` constructor option removed from `TaskStore`/`PluginStore` → TypeScript compile break for any external/plugin caller.
- `.changeset/embedded-postgres-lifecycle.md` — freeform body, missing `summary:`/`category:`/`dev:` (gate warns; `--strict` fails). *(project-standards; safe_auto)*

## P3 — Low
- `.returning()` would collapse insert-then-select double round-trips (`async-branch-groups.ts:120`, `async-monitor.ts:203`, …). *(safe_auto)*
- `searchTasks*` return unbounded result sets with no default cap (`async-search.ts:159`). *(safe_auto)*
- Repeated `as unknown as Record<string,unknown>` settings casts (`settings-ops.ts:63`).
- `flip-embedded-pg-default.md` filed `minor`/`feature` — a default-backend swap is arguably `major`/`breaking`.

---

## Learnings & Past Solutions (all honored in design, at risk in execution)

- **`docs/soft-delete-verification-matrix.md`** — the acceptance contract for R7. Findings #7, #28 are direct hits; re-run the matrix GREEN against the async store before cutover.
- **`docs/solutions/database-issues/schema-version-constant-must-equal-highest-migration.md`** — carry the version-gate discipline to the Drizzle journal; add a *seed-at-previous-state* upgrade test (not fresh-DB only).
- **`docs/solutions/database-issues/task-field-silently-dropped-without-sqlite-column-mapping.md`** — round-trip every `Task` field through `updateTask→getTask→reopen` (the `audit-ops.ts:59` cast is this risk realized).
- **`docs/solutions/integration-issues/engine-already-running-is-not-no-engine.md`** — the `taskClaims` two-write lease release must keep `BEGIN IMMEDIATE`-equivalent isolation (`SELECT FOR UPDATE`/serializable), not drift to plain READ COMMITTED.
- **`docs/solutions/test-failures/schema-version-sweep-must-include-plugin-workspaces.md`** — sweep plugin version pins from repo root after the first Drizzle migration bump; the roadmap plugin's snake_case vs camelCase column mismatch (api-contract residual) is unaudited.

---

## Deployment — Go/No-Go (blocking items)

1. No `fn db migrate` CLI (#27).
2. No automated pre-migration SQLite backup (operator must manually `cp` `fusion.db`, `archive.db`, `fusion-central.db`).
3. `pg_dump`/`pg_restore` not bundled (#26).
4. No auto-migrate → empty-DB-on-first-boot data-loss for naive upgraders.

Historical note: the original checklist included rollback via `FUSION_NO_EMBEDDED_PG=1`. The final cutover removed that runtime fallback; recovery now restores the retained SQLite backup into a controlled migration workflow, while normal startup always uses embedded PostgreSQL or `DATABASE_URL`.

---

## Residual Risks

- Embedded mode hard-codes superuser password `"password"` (local-only, 127.0.0.1 + random port — parity with prior local SQLite trust; consider a random per-instance password at 0600).
- Fixed `project`/`central`/`archive` schema names → two projects sharing one external `DATABASE_URL` clobber each other (no isolation).
- `tsvector GENERATED ALWAYS AS STORED` adds write amplification on every unrelated task update (heartbeat/timing writes recompute the vector).
- No `DATABASE_URL` format validation (`backend-resolver.ts:92`) — malformed URL fails only at connect.
- `pgRowToTaskRow` shim re-serializes parsed jsonb back to strings for `fromJson()`; any new async path skipping it feeds parsed objects to `JSON.parse` → `'[object Object]'` garbage (not enumerated across all helpers).

## Coverage

- Confidence gate: no findings suppressed below anchor 75 except retained P0@75 (#7); ~4 testing/maintainability P2/P3 advisory items demoted to soft buckets.
- All 13 reviewers returned results; 0 failures/timeouts.
- Testing gaps: no concurrency tests for the atomicity/lost-update paths (#7, #12, WIP); no perf benchmark for the N+1 hot paths at realistic volume; migrator untested for cross-table type collision, non-superuser FK-order fallback, pre-populated-target verification, and jsonb round-trip.

---

## Suggested Fix Order

1. **Restore the safety net:** #4 (provision Postgres in CI + fix `PG_AVAILABLE` probe) and #28 (rescue the deleted invariant tests) — so everything below is verifiable.
2. **Unblock the default backend:** #1, #2, #3 and the #8–#11 unguarded `store.db` methods — complete the `backendMode` branches (this is finding #13, the incomplete flip).
3. **Data-integrity guards:** #7, #12, #14, #15.
4. **Backup / lifecycle:** #5, #6, #23, #25, #26, #27.
5. **Performance:** #18, #19, #20, #21.
6. **Standards / structure:** #16, #17, #22, #29, #30.
