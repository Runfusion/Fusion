---
category: test-failures
module: testing
date: 2026-08-01
problem_type: suite_only_flake
component: PostgreSQL test infrastructure
severity: medium
applies_when:
  - "A test fails under full-suite parallelism but passes when run alone"
  - "A first flake sighting is in a file whose remaining coverage is substantial"
  - "Capturing evidence before a file-level quarantine decision"
  - "A merge-gate canary is evicted from the blocking gate after a flake sighting"
tags:
  - flake
  - postgres
  - full-suite
  - quarantine
---

# Observed suite-only flakes register

This register preserves first-sighting evidence under the narrow exception in [AGENTS.md](../../../AGENTS.md#standing-rule-flaky-tests-are-quarantined-on-sight-deletion-ratchet), and merge-gate eviction records. An eviction record documents a gate flake removed from the blocking canary list while coverage continues in the non-blocking lane. It is not a quarantine: the normal default remains a ledger entry plus matching Vitest `exclude` in the same commit.

## 1. Project identity returns no stored identity

- **File:** `packages/core/src/__tests__/postgres/project-identity.test.ts`
- **Exact test:** `project-identity async (PostgreSQL integration) > returns null when no identity is stored`
- **Observed tree/SHA:** `origin/main` at `7927c7b58a`
- **Observed frequency:** 1-in-3 full-core-suite runs.

| run | result |
|---|---|
| full core suite (1st) | **1 failed** / 4824 passed |
| full core suite (2nd) | 4825 passed |
| full core suite (3rd) | 4825 passed |
| file alone ×2 | 6 passed, 6 passed |

**Evidence gathering pending 2026-08-16 (FN-9125):** Current-sha diagnosis did not reproduce this historical first sighting: three six-worker full-core lanes and a twelve-worker PostgreSQL-directory run retained full output without this subject failing. The harness uses a shared golden template plus per-module copies, but no direct evidence tied this identity's null read to shared state. This is not superseded or resolved: the required complete loaded failure capture is absent. Core PostgreSQL quarantine is policy-forbidden, so FN-9126 owns CI/host-specific activity instrumentation, full failure capture, and the escalation decision.

| verification | result |
|---|---|
| full core ×3, 6 workers | subject passed; unrelated settings-revision-attribution failure |
| PostgreSQL directory, 12 workers | subject passed; unrelated satellite-store ordering failure |

**Second sighting — reproduced 2026-08-16 (FN-9126):** A credential-free, sterile-environment PostgreSQL-directory pass at 27 workers reproduced the registered assertion as a timeout at `packages/core/src/__tests__/postgres/project-identity.test.ts:41:3` on `3c235ce275b626a73da4fe508ac76fd6f5fbd686`. The typed, executor-authored per-run evidence is durable in task FN-9126, document key `evidence`; it records the 100-connection server ceiling and all run counters without retaining runner output. This is an escalation, not a resolution: core-config quarantine remains policy-forbidden by the gate-policy assertion, so FN-9131 owns root-cause diagnosis and a structural fix.

| run | result |
|---|---|
| PostgreSQL directory, 27 workers (run 1) | subject passed; 173 files; 1335 passed / 31 failed / 4 skipped |
| PostgreSQL directory, 27 workers (run 2) | **subject timeout reproduced**; 173 files; 942 passed / 46 failed / 382 skipped |

## 2. Schema applier retains registered dependents

- **Owner:** FN-9128
- **File:** `packages/core/src/__tests__/postgres/schema-applier.test.ts`
- **Exact test:** `schema-applier: VAL-SCHEMA-001 final-schema parity (table counts) > retains unreplaced registered dependents for every delete action`
- **Original observed tree:** PR [#2828](https://github.com/Runfusion/Fusion/pull/2828) merged-with-main.
- **Investigation tree/SHA:** `7380be699cfeb37f4fe706455cb07ef274d6cf31`.

The original failure block was not retained, so its mode cannot be reconstructed. FN-9128 ran the requested full-output campaign and **did not reproduce the registered test**: isolated control passed (45.6s); loaded core at default 6 workers (134.2s), 4 workers (159.0s), 8 workers (128.8s), and 12 workers (146.3s), plus a sampled 12-worker run (155.0s), all passed the schema-applier file and registered identity. The loaded runs retained unrelated settings-attribution failures at every fan-out; the 12-worker unsampled run also retained two unrelated command-center-activity failures. Those failures are not attributed to this entry.

DDL microbenchmarks of the pre-fix pristine shape measured `CREATE DATABASE` 44.5–106.9ms, pool connect 7.7–13.9ms, `applySchemaBaseline` 372.4–388.2ms, and forced drop 42.8–310.1ms. The registered four-action loop consequently pays about 1.5s of baseline DDL before its body. A 500ms all-database `pg_stat_activity` sample during the 12-worker run observed database-wide `DataFileWrite`, checkpoint, WAL, catalog-object, and advisory-lock waits; it did not establish a registered-test causal failure.

**Resolved 2026-08-16 (FN-9128):** The absence of a reproduced failure is recorded honestly, but measured repeated DDL and the bypassed shared lifecycle justified a structural isolation fix. The subject now uses `pg-test-harness`: first-apply and upgrade contracts use `createEmptyPgTestDatabase`, while schema-present parity and FN-8419 rekey contracts (including the registered four-action loop) use serialized `createBaselinedPgTestDatabase` clones, making their later apply a marker check instead of repeated DDL. Regression coverage proves both fixture states and that the registered path selects the baselined helper. No timeout, retry, assertion/title, skip, or quarantine change was made.

| run | result |
|---|---|
| full core suite on #2828 merged-with-main | **failed** (failure block unavailable) |
| file alone ×2 on the same tree | 75 passed, 75 passed |
| file alone on `origin/main` | passed |
| FN-9128 isolated + loaded campaign | registered test passed in every listed shape |

**Evidence gathering pending 2026-08-16 (FN-9125):** Current-sha loaded reproduction did not fail this assertion. This file still owns an inline unique `CREATE DATABASE` plus full baseline path rather than the shared template harness, but that is a distinct cost profile, not evidence that it caused the historical dependent-registration failure. This is not superseded or resolved: the required complete loaded failure capture is absent. FN-9128 exclusively owns entry 2's CI allocation/profile investigation and full failure capture; core PostgreSQL quarantine is policy-forbidden.

| verification | result |
|---|---|
| full core ×3, 6 workers | subject passed; unrelated settings-revision-attribution failure |
| PostgreSQL directory, 12 workers | subject passed; unrelated satellite-store ordering failure |

## 3. Plugin runner complete-lane lifecycle hook

- **File:** `packages/engine/src/__tests__/plugin-runner.test.ts`
- **Exact test:** `PluginRunner > task lifecycle hooks > should invoke onTaskCompleted when the complete lane is RENAMED`
- **Observed tree/SHA:** PR [#2799](https://github.com/Runfusion/Fusion/pull/2799) merged-with-main.

| run | result |
|---|---|
| full engine suite on #2799 merged-with-main (1st) | **8 failed** (7 in this file + 1 inherited) |
| full engine suite, same tree (2nd) | 1 failed (the inherited one only) |
| file alone | 80 passed |
| full engine suite on `origin/main` ×2 | clean |

Seven tests failed in `plugin-runner.test.ts`, but only this one identity survived capture: `--reporter=dot | tail -3` truncated the `FAIL` lines and retained only the summary.

**Quarantined 2026-08-16 (FN-9125):** Source inspection proved this unit file uses a local mocked TaskStore and has no PostgreSQL or harness import, so it does not belong to the database cluster. Three current full-engine lanes did not reproduce it, but the historical loaded failure lacks enough identities for a structural repair. The deletion-ratchet ledger and engine-default exclude were added together; assertions and timeouts are unchanged.

| verification | result |
|---|---|
| full engine ×3, 6 threads | subject passed; 35–36 unrelated baseline-red files remained |
| targeted plugin-runner | covered by subsequent quarantine-ledger verification |

**Retained after investigation 2026-08-17 (FN-9135):** FN-9135 temporarily lifted the paired default-lane exclusion and captured full verbose output for two runs each at 2, 6, and 8 workers. The subject passed every run and the 82-test isolated control; the loaded lane's unrelated baseline-red files did not identify a product or harness cause. The fixed microtask flush, duplicate helper, registry singleton, and hook timeout were investigated, but no root-cause defect or qualifying rescue was demonstrated. The test file, ledger row, and default-lane exclusion therefore remain together until the 2026-08-30 ratchet deadline, preserving plugin loading/contribution/runtime/hot-reload coverage and the remaining `onTaskCompleted` lifecycle-dispatch coverage.

| FN-9135 loaded reproduction | subject result | whole-lane result |
|---|---|---|
| 6 workers, run 1 (247.08s) | pass | 40 failed / 794 passed files; unrelated baseline-red |
| 8 workers, run 1 (197.47s) | pass | 40 failed / 794 passed files; unrelated baseline-red |
| 2 workers, run 1 (577.55s) | pass | 39 failed / 795 passed files; unrelated baseline-red |
| 6 workers, run 2 (230.06s) | pass | 39 failed / 795 passed files; unrelated baseline-red |
| 8 workers, run 2 (188.61s) | pass | 39 failed / 795 passed files; unrelated baseline-red |
| 2 workers, run 2 (590.97s) | pass | 39 failed / 795 passed files; unrelated baseline-red |

## 4. Planning Mode direct task handoff

- **File:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
- **Exact test:** `PlanningModeModal sequential flow > creates the task directly and offers task and session-list handoffs`
- **Observed tree/SHA:** `4e21f53996` (FN-8757 worktree)
- **Observed frequency:** first observation in the targeted file run.

| run | result |
|---|---|
| targeted file run | **1 failed** / 56 passed; `mockCreateTaskFromPlanning` was not called and jsdom reported unimplemented `window.scrollTo()` |
| isolated exact test | passed |

The failure is unrelated to the mobile question footer: it exercises the completed-plan Proceed handoff, while FN-8757 changes only the active-question footer. The file retains substantial coverage, so this first sighting is recorded rather than quarantined; a second sighting requires the normal file-level quarantine.

**Superseded 2026-08-10 (FN-8936):** The second sighting moved the file to the deletion-ratchet ledger. Investigation classified the direct handoff as a detached test-node hydration race, not a product create-state race; the suite was rescued by settling hydration and re-querying the live Proceed action before every previously unsafe direct click. The ledger and Vitest exclusion were removed together after exact and loaded-file proof, without timeout/retry/assertion appeasement.

## 5. Planning Mode mobile plan-tab selection

- **File:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
- **Exact test:** `PlanningModeModal sequential flow > uses full-view Questions and Plan preview tabs on mobile`
- **Observed tree/SHA:** `main` at `4ff41a723c` with the Planning Mode task-creation fix uncommitted.
- **Observed frequency:** first observation in a targeted three-file dashboard run.

| run | result |
|---|---|
| targeted three-file dashboard run | **1 failed** / 198 passed; React reported an update outside `act(...)`, and the Plan tab still had `aria-selected="false"` immediately after `fireEvent.click` |

The failure exercises the pre-existing mobile tab transition, while the task-creation fix changes the completed-plan Proceed handoff. The file retains substantial coverage, so this first sighting is recorded rather than quarantined; a second sighting requires the normal file-level quarantine.

**Suite re-admitted 2026-08-10 (FN-8936):** This first-sighting mobile observation did not receive a second failure. The shared file-level quarantine was removed only after the direct-handoff root cause was structurally fixed and the unexcluded loaded suite, including this mobile coverage, passed.

## Common shape and investigated result

FN-9125 established that entry 3 is not PostgreSQL-suite-adjacent: `plugin-runner.test.ts` uses an in-memory mocked TaskStore and has no PostgreSQL/harness import. FN-9135's bounded reproduction campaign did not identify the root cause needed to rescue it, so the suite remains quarantined with its coverage intact until the ratchet deadline. Entries 1, 2, and 7 remain evidence-gathering-pending PostgreSQL observations: current full-output runs at six workers plus a twelve-worker PostgreSQL-directory run did not reproduce any subject identity, so FN-9125 cannot claim them superseded or resolved. The golden-template/advisory-lock lifecycle and schema-applier's inline baseline path are concrete architecture facts, not a demonstrated cause of these assertions. Core policy forbids inline PG quarantine: FN-9126 owns entry 1, FN-9128 exclusively owns entry 2, and FN-9127 owns entry 7 for CI/host-specific `pg_stat_activity`, lifecycle timing, and a complete loaded failure capture before any source or fan-out change. Entry 6 instead records a merge-gate eviction after a loaded-lane setup-hook timeout; `FNXC:PgTestTemplateDb 2026-07-19-17:20` and `FNXC:PgTestWorkerCap 2026-07-18-18:00` are already-landed mitigations for that mode, not new diagnoses to re-open. The Planning Mode entries are separate frontend timing observations.

## Policy and escalation

Quarantine is file-level, while the first-sighting exception preserves coverage in files retaining 6 / 75 / 80 passing tests. Under that exception, recording preserves valuable coverage. A **second sighting** of a registered test is an on-sight quarantine: add it to `scripts/lib/test-quarantine.json` and the matching Vitest `exclude` in one lockstep commit; this register entry is then evidence for the ledger `reason`.

Merge-gate eviction records follow a separate branch: the gate can no longer be reddened by that file, while the non-blocking suite retains coverage. A further failure there is an ordinary on-sight quarantine. For PostgreSQL files, the gate-policy assertion forbidding a core-config quarantine exclude makes that an owner decision escalated as its own task rather than an inline edit.

Capture **full runner output** before recording or quarantining a failure—for example, tee it to a file. Never pipe a dot reporter through `tail`: the summary survives while the `FAIL` identity lines needed for a quarantine entry are exactly what gets truncated.

Source: [Runfusion/Fusion issue #2862](https://github.com/Runfusion/Fusion/issues/2862).

## 6. Sync workflow IR default canary setup hook

- **File:** `packages/core/src/__tests__/postgres/sync-workflow-ir-is-always-default.pg.test.ts`
- **Exact test:** `resolveTaskWorkflowIrSync ignores a task's real workflow (PostgreSQL)` suite `beforeAll` setup hook.
- **Observed tree/SHA:** FN-8912 evidence; local confirmation tree `51437558ac352dad3481e0dbe9622fa51af4c599`.
- **Observed frequency:** 1 observed merge-gate sighting in FN-8912; not reproduced locally. This is an **evicted merge-gate canary**, not a first-sighting register exception.

| run | result |
|---|---|
| FN-8912 loaded `pnpm test:gate` | **setup hook timed out** at the inherited 15s budget; direct scoped rerun passed |
| shape A: capped `test:pg-gate` ×5 | 3 files / 13 tests passed each run |
| shape B: isolated target ×3 | 1 file / 3 tests passed each run |
| shape C: uncapped default-config PostgreSQL directory ×5 | 153 files / 1263 passed plus 1 skipped each run |

FN-8928 evicted the file from the blocking gate under the AGENTS.md gate rule; default-core discovery preserves its regression coverage. Shape C was clean, so no quarantine escalation was required. A later non-blocking-core failure is an ordinary on-sight quarantine decision. `FNXC:PgTestTemplateDb 2026-07-19-17:20` (run-shared golden template) and `FNXC:PgTestWorkerCap 2026-07-18-18:00` (four-fork PG-gate cap) are already-landed mitigations for this same 15s setup-hook timeout mode.

## 7. Mission store PostgreSQL teardown hook

- **File:** `packages/core/src/__tests__/postgres/mission-store.pg.test.ts`
- **Exact test:** `MissionStore (PostgreSQL backend mode)` suite `afterAll` hook (`h.afterAll`).
- **Observed tree/SHA:** `32f677bbc207e421fd260ae2ba22fcefeeef4d86` (FN-8979 worktree).
- **Observed frequency:** first observation in a direct targeted rerun; 61 tests in the file passed.

| run | result |
|---|---|
| targeted file with `--silent=passed-only` | passed (exit 0) |
| targeted file with dot reporter | **afterAll hook timed out** at 15s; 61 tests passed |

The timeout occurred after all test assertions and is unrelated to FN-8979's canonical mission-blocker contract. This file retains substantial coverage, so this first observation is recorded rather than quarantined. A second sighting requires the normal file-level quarantine decision.

**Evidence gathering pending 2026-08-16 (FN-9125):** The shared-harness teardown is serial (store, layer, admin client, `DROP DATABASE WITH (FORCE)`, temporary directory), so a loaded close/drop block remains a plausible historical mechanism. Three targeted dot-reporter runs and loaded core reproduction did not produce a timeout or a measurable slow phase. This is not superseded or resolved: the required complete loaded failure capture is absent. FN-9127 owns CI/host-specific phase instrumentation, full failure capture, and the escalation decision; core PostgreSQL quarantine is policy-forbidden.

| verification | result |
|---|---|
| targeted dot reporter ×3 | 61 tests passed; afterAll passed |
| full core ×3, 6 workers | subject passed; unrelated settings-revision-attribution failure |

**Instrumented outcome 2026-08-16 (FN-9127): entry 7 remains unreproduced and is now self-diagnosing.** The default-off teardown recorder was measured on `beb8ae67dba1ed122cab94a4641e875ccebd21f1` against PostgreSQL 15.15 (`max_connections=100`, 97 ordinary slots). It writes synchronous JSONL records and its in-flight phase/teardown watchdogs fire before the inherited 15s hook is aborted, so a phase that never settles still leaves timing plus `pg_stat_activity` evidence. The durable campaign tables and full snapshot rows are retained in task document `FN-9127/evidence`; `/tmp/fn-9127-*.log` and `/tmp/fn-9127-diag-*.jsonl` are scratch copies only.

| instrumented shape | result | measured worst phase | watchdog / snapshot |
|---|---|---:|---|
| subject dot ×3 | all passed | `dropDatabase` 154ms | no / none |
| full core, 4 workers | unrelated settings attribution failure | 1,439ms globally | no / none |
| full core, 6 workers | unrelated settings attribution failure | 1,576ms globally | no / none |
| full core, 8 workers | unrelated settings attribution failure | 1,905ms globally | no / none |
| full core, 12 workers | unrelated settings attribution + schema-applier timeout | `dropDatabase` 3,582ms globally | 30 / 30 |

The 12-worker snapshots show 21 backends and concurrent template `CREATE DATABASE`/`DROP DATABASE WITH (FORCE)` work, including `IPC/CheckpointDone` and `IPC/ProcSignalBarrier`; they do not implicate this mission-store suite. FN-9130 measured advisory admission as a non-remedy: uniform pooling regressed to 49 watchdogs / 5,068ms and drop-only wiring to 27 / 3,361ms against the 4–5 / 3,284ms baseline. A bounded deferred-drop reaper also failed the end-to-end criterion: watchdogs became zero by construction, but two green runs took 117.2s and 122.4s versus the 108.1s baseline maximum, and a later run timed out in unrelated loaded setup. The reaper was reverted and candidate C is tracked by FN-9136. The evidence remains unresolved rather than becoming a quarantine or timeout change. No teardown behavior was changed: there is no evidence-backed cause for this entry's historical 15s afterAll abort. This first-sighting record remains retained; a second sighting follows the normal escalation. Core PostgreSQL files cannot be quarantined inline because the gate-policy assertion requires `quarantinedCoreTests` to remain empty; that is an owner-escalated decision.

## 8. Planning Mode duplicate-response generation reconciliation

- **File:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
- **Exact test:** `PlanningModeModal sequential flow > silently reconciles duplicate-response generation conflicts on $viewport with $label`

<!-- FNXC:TestFlakeRegister 2026-08-16-10:52: Parametrized `it.each` cases are registered by their source-template title because the register validator checks raw test-file hierarchy segments. The concrete failing `'mobile'` row (`a durable next question`) and earlier contaminated `'desktop'` row remain recorded below as evidence. -->
- **Observed tree/SHA:** `main` at `8ee2ace2c1` (dashboard bare-run repair batch).
- **Observed frequency:** one clean sighting — solo standard-lane run (`node scripts/run-quality-tests.mjs`, lane `app:backfill-3`) on a quiet machine; the earlier `'desktop'`-row failure ran concurrently with a full bare vitest run and live peer-session edits to planning API files, so it is recorded as context, not as an independent clean sighting.

| run | result |
|---|---|
| solo standard lane (quiet machine) | **1 failed** (`'mobile'` row) / rest of lane passed |
| targeted file run immediately after | 58/58 passed |
| earlier busy-machine standard lane | **1 failed** (`'desktop'` row); targeted rerun 58/58 passed |

This file now carries THREE distinct register/ledger histories (entries 4 and 5 above plus this one) and one prior FN-8936 stabilization. Under the AGENTS.md repeated-quarantine rule this is a subsystem product-race smell: the duplicate-response generation reconciliation path (FN-8756 banner suppression / duplicate-generation dedup) should be investigated as a product race rather than stabilized a fourth time. Filed as a Fusion task; a second clean sighting of this exact test is an ordinary on-sight quarantine.

**Resolved 2026-08-16 (FN-9116): Product race.** `handleSubmitResponse` caught a duplicate response-generation rejection, awaited `fetchAiSession(sessionId)`, then wrote its old session snapshot after a newer writer could already own the UI. The fix captures the response load and turn epochs before the response await, so an A → B → A reload cannot let the old A response adopt the new A load epoch. Every reconciliation/fallback write drops when a newer load, response, stream event, or recovery transition owns the view.

Crucially, an accepted SSE `onError` is a turn boundary only after stale-event rejection. Its recovery captures that turn token across fetch and auto-retry awaits; a later response cannot be overwritten by an old reconnect, retry failure, or permanent error, and reconciliation from the errored turn cannot overwrite the recovery. The loading-poll error path now also claims its recovery turn *before* auto-retry: a successful retry returns early, so claiming afterward had left a held reconciliation authorized to overwrite recovery loading state.

FN-9116 adds deterministic ordering coverage for desktop and mobile rows across durable-question, result-only plan-review, generating snapshots, A → B → A reload/rejection, `onError`-before-reconciliation, `onError` recovery losing ownership to a later response, and loading-poll recovery landing before a held reconciliation. The non-duplicate actionable-error assertions remain intact and passing. Response actions now settle hydration and query the live control before dispatch, removing the detached hydration-node test seam without changing product semantics.

- **Resolved tree/SHA:** `d5f29bbdbc` (FN-9116 worktree; final documentation commit follows).

| verification | result |
|---|---|
| targeted planning-flow file ×3 | **passed** (76 tests each run) |
| shared-helper sibling suites ×1 | **passed** |
| `app:backfill-3` run 1 | **passed** (5,693 tests) |
| `app:backfill-3` run 2 | **passed** (5,693 tests) |
| `app:backfill-3` run 3 | **passed** (5,693 tests) |
| `pnpm lint`, `pnpm verify:fast`, `pnpm build` | **passed** |

The flake is structurally removed rather than stabilized: every hydration/recovery writer now has an ownership boundary before it can overwrite a newer turn. This is a published behavior fix, so FN-9116 includes a patch changeset.

## 11. Settings revision attribution reset-ordering assertion

- **File:** `packages/core/src/__tests__/settings-revision-attribution.test.ts`
- **Exact test:** `settings revision attribution > round-trips every explicit provenance variant through committed JSONB revisions`
- **Owner:** FN-9129
- **Observed tree/SHA:** retained FN-9128 logs; remediation started at `5e5422de6e57ead4f0c4a253b47b59063c1f9fe3`.
- **Observed frequency:** 5/5 retained loaded full-core runs (default, 4, 8, 12, and sampled 12 workers), not 4/5.

| run | result |
|---|---|
| FN-9128 loaded campaign | **failed 5/5**; retained `/tmp/fn-9128-core-*.log` |
| FN-9129 isolated pre-fix | **failed**; `/tmp/fn-9129-solo-1.log` |
| FN-9129 full core, 4 workers ×3 | subject passed after repair; first run had unrelated satellite-store failure, remaining two runs clean |
| FN-9129 full core, 12 workers ×1 | passed after repair; co-observed command-center cases passed |

Verbatim observed failure:

```
FAIL  src/__tests__/settings-revision-attribution.test.ts > settings revision attribution > round-trips every explicit provenance variant through committed JSONB revisions
AssertionError: expected [ { id: 'fusion-system', …(1) }, …(4) ] to deeply equal [ { kind: 'human', …(1) }, …(4) ]
```

**Resolved 2026-08-16 (FN-9129):** This was not configuration-provenance loss. A direct table dump retained in the FN-9129 `evidence` task document and `/tmp/fn-9129-instrumented.log` showed all five explicit actors physically persisted among 19 rows. The shared harness intentionally restarts identities between tests; consequently `ORDER BY sequence ASC` has duplicate values across reset boundaries, and the test's `.slice(before.length)` count window selected previous system rows. The assertion now identifies each explicit write by its test-owned `taskPrefix`, retains its immutable revision UUID, and re-reads only those IDs; regression coverage adds a post-snapshot background system write to prove it cannot enter the provenance assertion. This preserves the provenance invariant without retries, waits, quarantines, timeout changes, or a broad harness mutation.

The two command-center durable-agent activity cases observed once at 12 workers are classified as co-observed identity-reuse risk, not this subject's cause: the repaired 12-worker campaign passed them. Core PostgreSQL quarantine remains forbidden and `quarantinedCoreTests` remains empty.

## 9. Create Room picker loaded-lane state ordering

- **File:** `packages/dashboard/app/components/__tests__/CreateRoomModal.test.tsx`
- **Exact test:** `CreateRoomModal > shows loading, empty, no-match, populated, and selected-member picker states`
- **Observed tree/SHA:** `7527d2651f` (FN-9120 baseline).
- **Observed frequency:** 2/2 loaded `dashboard-app-quality-backfill` shard-2 runs failed; a targeted rerun had passed before this investigation.

| run | result |
|---|---|
| loaded backfill shard 2 | **failed** — 1 failed / 2,134 passed; full output retained |
| loaded backfill shard 2 with picker instrumentation | **failed** — same assertion; fetch calls were exactly 1/2/3 and the member list still rendered Alpha/Beta after typing `zzz` |
| new ordering tests against unfixed component | **failed** — stale project result overwrote current roster; rejected load rendered no-agents copy |

**Resolved 2026-08-16 (FN-9120): both a timing-sensitive test assertion and a product race.** The original third phase synchronously asserted after `userEvent.type` while the loaded lane still rendered populated rows, even though its once queue had not shifted. Independently, the production effect had no cleanup or request identity, so a close/reopen, project change, or unmount could let a stale fetch write roster/loading/error state; initial `loadingAgents=false` also exposed terminal empty copy before the first effect.

The component now owns an explicit idle/loading/loaded/failed phase and fences each request with an epoch plus cleanup. A current successful reload removes selected IDs absent from its roster. The test uses controlled deferred promises in a single persistently-mounted modal, proves close/reopen/project ordering, failure and unmount fencing, duplicate-name/selection reconciliation, and desktop/mobile empty-state copy invariants without retries, sleeps, waits around the old assertion, or mock re-pinning.

## 10. Planning Mode loaded-turn affordance ownership

- **Files:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`, `PlanningModeModal.ui-interactions.test.tsx`
- **Exact cases:** `opens Plan preview without submitting and preserves the current mobile answer on return`; `can restart initial planning after stopping its first generation`; `can refine a stopped initial plan into the first question`; both desktop/mobile rows of `keeps five substantive choices and one Other usable on %s`; `submits an answer after deferred same-session hydration on %s`; and FN-9117's `keeps post-Stop plan review when a pre-Stop loading poll resolves on %s`.
- **Observed tree/SHA:** original reports at `9a9e591b72`; completed remediation tree `603373b93a`.

**Resolved 2026-08-16 (FN-9117): Product ownership race, not a timeout defect.** `QuestionForm` rendered from `workspaceQuestion`, while submit formerly branched on a closed-over `view`; a late hydration could therefore drop an enabled Next action. It also restored every new `initialResponse` object identity, overwriting a dirty same-question draft and disabling the mobile Next-question path. FN-9117 binds submit to the live session/question state and preserves a dirty same-question draft.

The Stop audit also confirmed the recovery-poll ownership hazard: Stop invalidates loading state then can restore the same session id for a question or summary terminal view. FN-9116's load-and-turn fence now rejects a poll started before that boundary. FN-9117 adds real-modal desktop and mobile deferred-poll coverage: fake timer time starts the 8-second poll, a deferred stale durable question resolves after Stop, and post-Stop plan review remains intact. The pre-FN-9116 source had effect-cleanup cancellation once terminal React state committed; the epoch fence closes the earlier render/cleanup interval structurally. No timeout, retry, widened wait, sleep, weakened assertion, or quarantine was used.

This completes the two Stop reports rather than deferring them as unreproduced. A same-session `ai_session:updated` rehydrate was the remaining transient-unmount path: `loadSession` cleared `workspaceQuestion` before its fetch resolved, unmounting `QuestionForm` and discarding the dirty answer. It now preserves an active question/plan-review workspace only for a refresh of that same session; a different session still enters the neutral loader. The real-modal deferred-hydration test uses per-character `userEvent.type` on desktop and the mobile Other choice, then asserts the exact `respondToPlanning` payload after the controlled commit.

It is the companion to entries 4, 5, and 8: FN-8936 fixed detached test-node handoff; FN-9116 fences duplicate-response and recovery writers; FN-9117 ensures visible question controls use the live turn and retain operator drafts.

| verification | result |
|---|---|
| targeted planning-flow + ui-interactions ×3 | **passed** (84 planning-flow tests, 20 UI-interaction tests) |
| all `PlanningModeModal.*` sibling suites | **passed** |
| `test:quality:app:backfill` aggregate attempt | shards 1–3 passed; initial 300s bound ended during shard 4, which passed when run directly |
| `test:quality:app:backfill` aggregate attempts 2–3 | blocked by repeated unrelated `CreateRoomModal` search-state failures; filed as FN-9121 with full logs `/tmp/fn-9117-backfill-run-{2,3}.log` |
| `pnpm lint`, `pnpm verify:fast`, `pnpm build` | **passed** |

No UI surface changed; this was a state-ownership and regression-coverage repair. The existing patch changeset remains applicable because Planning Mode behavior is user-visible.

## 12. Satellite approval audit lifecycle ordering assertion

- **File:** `packages/core/src/__tests__/postgres/satellite-stores.pg.test.ts`
- **Exact test:** `PostgreSQL satellite stores (U6 consolidated, shared harness) > PostgreSQL satellite DB-injected stores (VAL-DATA-016) > ApprovalRequestStore: replayed/conflicting decisions 409, grants expire, ownership enforced`
- **Owner:** FN-9132
- **Observed tree/SHA:** deterministic pre-fix reproduction on `b31be1ba7c7415b9ee20c4c76875c961be73a0c3`; structural fix begins at `c3e3a2648a`.
- **Observed frequency:** co-observed in retained FN-9125 12-worker PostgreSQL-directory, FN-9129 4-worker full-core run 1, and FN-9130 loaded-measurement evidence.

Verbatim observed failure:

```
FAIL  src/__tests__/postgres/satellite-stores.pg.test.ts > PostgreSQL satellite stores (U6 consolidated, shared harness) > PostgreSQL satellite DB-injected stores (VAL-DATA-016) > ApprovalRequestStore: replayed/conflicting decisions 409, grants expire, ownership enforced
AssertionError: expected [ 'approved', 'created' ] to deeply equal [ 'created', 'approved' ]
```

| run | result |
|---|---|
| retained FN-9125 PostgreSQL directory, 12 workers | **failed** with the verbatim ordering assertion |
| retained FN-9129 full core, 4 workers run 1 | **failed** with the verbatim ordering assertion |
| FN-9132 deterministic one-worker frozen-Date repro, pre-fix | **failed**; both rows existed with identical `createdAt` values |
| FN-9132 targeted lifecycle, project-isolation, satellite, and dashboard-route suites | **passed** post-fix |
| FN-9132 PostgreSQL directory, 12 workers | **passed**; 173 files, 1370 tests passed, 1 skipped |

**Resolved 2026-08-16 (FN-9132):** This was a product ordering defect in `getApprovalAuditHistory`, not PostgreSQL DDL contention, harness identity reuse, or test timing. `appendAuditEvent` creates deterministic IDs containing the event type, while the read ordered tied timestamps by `id ASC`; that lexically placed `approved` before `created`. The read now applies a lifecycle rank derived from `APPROVAL_REQUEST_AUDIT_EVENT_TYPES`, followed by ID only as a final total-order tiebreak. Regression coverage freezes `Date` around real create/decide/complete writes and proves tied approved, denied, and completed states, distinct timestamps, mixed ties, project isolation, and the public store delegate. No timeout, retry, worker-count, skip, assertion weakening, or quarantine change was made; `quarantinedCoreTests` remains empty.

This resolves the previously unclassified “unrelated satellite-store ordering failure” mentions in entry 1's 12-worker verification table, entry 2's 12-worker verification table, and entry 11's FN-9129 4-worker run table. Those sightings are now classified separately from their entries' identity and DDL investigations.
