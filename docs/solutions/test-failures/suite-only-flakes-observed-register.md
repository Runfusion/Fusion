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

This register has **4 active observation records** (entries 1, 2, 7, and 13): **3 active first sightings** and **1 escalated second sighting**. It also has **1 merge-gate eviction record** (entry 6) and **8 archived closed records**. Only the active section drives quarantine and escalation decisions; the other sections preserve historical evidence.

<!--
FNXC:TestFlakeRegister 2026-08-19-11:14:
The flat register mixed closed narratives with open records, making it unusable as a quarantine-on-sight decision aid. Sections make the active decision surface explicit while entry numbers and heading text remain frozen for inbound anchors and cross-reference stability. Active status lines must distinguish first sightings from reproduced escalations and name the evidence owners retained by each record.
-->

## Active observation records

### 1. Project identity returns no stored identity

- **Status:** Active reproduced-but-unattributed observation — evidence owner FN-9146.

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

<!--
FNXC:PostgresFlakeDiagnosis 2026-08-19-12:25:
FN-9146 requires every active core PostgreSQL record to retain its own complete campaign verdict. Each per-run row carries the lane shape, selected subject result, wall-clock, whole-lane outcome, and measured cluster capacity so later sightings cannot collapse evidence from a different identity or mistake an unsampled run for pressure evidence.
-->

**Campaign outcome 2026-08-19 (FN-9146):** The pre-registered A×4/B×3/C×3/D×2 campaign completed at `ed2cbd08a13f02f1fa5e19d5072c471bb972a315` on PostgreSQL 15.15. The exact null-read identity timed out at its inherited 15s budget in A02–A04. Snapshots peaked at 73, 62, and 71 backends, below the 97 ordinary slots, and showed concurrent DDL/checkpoint/object-lock/WAL waits. Those records do not name a causal lifecycle seam: connection exhaustion, template ownership, drop contention, and the deliberately-unwired budget primitive remain unproven. Entry 1 stays active and reproduced-but-unattributed under FN-9146; no structural change, timeout/retry, or core-PG quarantine was made. Complete combined output and teardown JSONL for A01–D02 are durable FN-9146 task attachments, with parsed checkpoints in its task documents.

**Capacity-evidence remediation 2026-08-19 (FN-9146):** C01–C03's original green default-core logs had no activity snapshot, so they cannot substantiate a peak. One sampled replacement per affected shape (C01R–C03R) completed green with an external 250ms `pg_stat_activity` count sampler: 28/31/30 observed backends across 583/491/508 samples. The table labels retain the pre-registered C identities and disclose their sampled replacements; these are new measurements, not retroactive values for the original C logs. Each replacement retained full runner output, teardown JSONL, and sampler output in FN-9146's durable evidence checkpoint; after C03R, the dead-owner golden template was dropped and the leftover count returned to zero.

| run | shape / workers | wall | subject result | whole-lane result | cluster capacity (`max`/ordinary; peak) |
|---|---|---:|---|---|---|
| A01 | directory / 27 | 235.8s | pass | 25 files / 45 tests red | 100/97; 73 |
| A02 | directory / 27 | 220.2s | **captured: 15s timeout** | 60 files / 42 tests red | 100/97; 73 |
| A03 | directory / 27 | 205.5s | **captured: 15s timeout** | 35 files / 31 tests red | 100/97; 62 |
| A04 | directory / 27 | 224.2s | **captured: 15s timeout** | 36 files / 39 tests red | 100/97; 71 |
| B01 | directory / 12 | 110.8s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 26 |
| B02 | directory / 12 | 119.2s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 36 |
| B03 | directory / 12 | 121.1s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 28 |
| C01 / C01R | core default | 163.5s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 28 (583 samples) |
| C02 / C02R | core default | 136.6s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 31 (491 samples) |
| C03 / C03R | core default | 141.1s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 30 (508 samples) |
| D01 | configured pg gate / 4 forks | 3.6s | not selected | green, 2 files / 10 pass | 100/97; not sampled |
| D02 | configured pg gate / 4 forks | 3.7s | not selected | green, 2 files / 10 pass | 100/97; not sampled |

### 2. Schema applier retains registered dependents

- **Status:** Active first sighting — evidence owner FN-9146.

The FN-9128 harness-isolation fix does not close this record because no reproduced failure explained the original assertion mechanism.

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

**Campaign outcome 2026-08-19 (FN-9146):** The exact registered dependents identity passed every subject-containing lane (A×4/B×3/C×3); D01–D02 do not select this file. The historical mode remains unattributed. Entry 2 stays active under FN-9146; the next sighting follows normal escalation and core PostgreSQL quarantine remains policy-forbidden. Complete combined output and teardown JSONL for A01–D02 are durable FN-9146 task attachments, with parsed checkpoints in its task documents.

**Capacity-evidence remediation 2026-08-19 (FN-9146):** C01–C03's original green default-core logs had no activity snapshot, so they cannot substantiate a peak. One sampled replacement per affected shape (C01R–C03R) completed green with an external 250ms `pg_stat_activity` count sampler: 28/31/30 observed backends across 583/491/508 samples. The table labels retain the pre-registered C identities and disclose their sampled replacements; these are new measurements, not retroactive values for the original C logs. Each replacement retained full runner output, teardown JSONL, and sampler output in FN-9146's durable evidence checkpoint; after C03R, the dead-owner golden template was dropped and the leftover count returned to zero.

| run | shape / workers | wall | subject result | whole-lane result | cluster capacity (`max`/ordinary; peak) |
|---|---|---:|---|---|---|
| A01 | directory / 27 | 235.8s | pass | 25 files / 45 tests red | 100/97; 73 |
| A02 | directory / 27 | 220.2s | pass | 60 files / 42 tests red | 100/97; 73 |
| A03 | directory / 27 | 205.5s | pass | 35 files / 31 tests red | 100/97; 62 |
| A04 | directory / 27 | 224.2s | pass | 36 files / 39 tests red | 100/97; 71 |
| B01 | directory / 12 | 110.8s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 26 |
| B02 | directory / 12 | 119.2s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 36 |
| B03 | directory / 12 | 121.1s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 28 |
| C01 / C01R | core default | 163.5s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 28 (583 samples) |
| C02 / C02R | core default | 136.6s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 31 (491 samples) |
| C03 / C03R | core default | 141.1s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 30 (508 samples) |
| D01 | configured pg gate / 4 forks | 3.6s | not selected | green, 2 files / 10 pass | 100/97; not sampled |
| D02 | configured pg gate / 4 forks | 3.7s | not selected | green, 2 files / 10 pass | 100/97; not sampled |

### 7. Mission store PostgreSQL teardown hook

- **Status:** Active first sighting — evidence owner FN-9146.

- **File:** `packages/core/src/__tests__/postgres/mission-store.pg.test.ts`
- **Exact test:** `MissionStore (PostgreSQL backend mode)` suite `afterAll` hook (`h.afterAll`).
- **Observed tree/SHA:** `32f677bbc207e421fd260ae2ba22fcefeeef4d86` (FN-8979 worktree).
- **Observed frequency:** first observation in a direct targeted rerun; 61 tests in the file passed.

| run | result |
|---|---|
| targeted file with `--silent=passed-only` | passed (exit 0) |
| targeted file with dot reporter | **afterAll hook timed out** at 15s; 61 tests passed |

The timeout occurred after all test assertions and is unrelated to FN-8979's canonical mission-blocker contract. This file retains substantial coverage, so this first observation is recorded rather than quarantined. A second sighting requires the normal file-level quarantine decision.

**Evidence gathering pending 2026-08-17 (FN-9136):** The shared-harness teardown is serial (store, layer, admin client, `DROP DATABASE WITH (FORCE)`, temporary directory), so a loaded close/drop block remains a plausible historical mechanism. FN-9136's seven-pair per-fork `TRUNCATE` reuse campaign was rejected because its experimental fork cleanup leaked dead-owner databases; that rejection preserves isolation but does not resolve this original loaded timing symptom. FN-9127 retains CI/host-specific phase instrumentation and full failure capture ownership; core PostgreSQL quarantine is policy-forbidden.

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

The 12-worker snapshots show 21 backends and concurrent template `CREATE DATABASE`/`DROP DATABASE WITH (FORCE)` work, including `IPC/CheckpointDone` and `IPC/ProcSignalBarrier`; they do not implicate this mission-store suite. FN-9130 measured advisory admission as a non-remedy: uniform pooling regressed to 49 watchdogs / 5,068ms and drop-only wiring to 27 / 3,361ms against the 4–5 / 3,284ms baseline. A bounded deferred-drop reaper also failed the end-to-end criterion: watchdogs became zero by construction, but two green runs took 117.2s and 122.4s versus the 108.1s baseline maximum, and a later run timed out in unrelated loaded setup. The reaper was reverted. FN-9136 then rejected candidate C after its golden-template gate passed: the required seven-pair 12-worker campaign left pooled `fusion_pool_*` databases owned by dead fork PIDs because the experiment lacked an awaited fork-exit flush and direct imports degraded to the shared `local` identity. The isolation failure required removing all harness wiring regardless of wall time. FN-9134 supplied a pre-registered report-only lane metric and completed its required seven-pair alternating control/candidate campaign at 12 workers. The control/candidate medians were 137.81s/146.91s, candidate pairs 02–06 were red, and every sample observed 32 or 33 surviving `fusion_test_%` databases (pair 04 increased 32 to 33). The tool's `no-improvement` verdict and the automatic non-zero-leak rejection removed the prototype and all of its wiring/tests together. The full per-run JSONL/log evidence is retained in task document `FN-9134/evidence`; this remains unresolved rather than becoming a quarantine or timeout change. No teardown behavior was changed: there is no evidence-backed cause for this entry's historical 15s afterAll abort. This first-sighting record remains retained; a second sighting follows the normal escalation. Core PostgreSQL files cannot be quarantined inline because the gate-policy assertion requires `quarantinedCoreTests` to remain empty; that is an owner-escalated decision.

**Campaign outcome 2026-08-19 (FN-9146):** The registered `afterAll(h.afterAll)` hook did not fail in every lane that selected this file. A02 instead timed out in `beforeAll(h.beforeAll)`, so its registered `afterAll` did not run and is recorded as not reached rather than passed; it is explicitly not entry-7 evidence. D01–D02 do not select the file. The historical afterAll mode remains unattributed. Entry 7 stays active under FN-9146; the next sighting follows normal escalation and core PostgreSQL quarantine remains policy-forbidden. Complete combined output and teardown JSONL for A01–D02 are durable FN-9146 task attachments, with parsed checkpoints in its task documents.

**Capacity-evidence remediation 2026-08-19 (FN-9146):** C01–C03's original green default-core logs had no activity snapshot, so they cannot substantiate a peak. One sampled replacement per affected shape (C01R–C03R) completed green with an external 250ms `pg_stat_activity` count sampler: 28/31/30 observed backends across 583/491/508 samples. The table labels retain the pre-registered C identities and disclose their sampled replacements; these are new measurements, not retroactive values for the original C logs. Each replacement retained full runner output, teardown JSONL, and sampler output in FN-9146's durable evidence checkpoint; after C03R, the dead-owner golden template was dropped and the leftover count returned to zero.

| run | shape / workers | wall | subject result | whole-lane result | cluster capacity (`max`/ordinary; peak) |
|---|---|---:|---|---|---|
| A01 | directory / 27 | 235.8s | pass | 25 files / 45 tests red | 100/97; 73 |
| A02 | directory / 27 | 220.2s | not reached: `beforeAll` timeout (not registered `afterAll`) | 60 files / 42 tests red | 100/97; 73 |
| A03 | directory / 27 | 205.5s | pass | 35 files / 31 tests red | 100/97; 62 |
| A04 | directory / 27 | 224.2s | pass | 36 files / 39 tests red | 100/97; 71 |
| B01 | directory / 12 | 110.8s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 26 |
| B02 | directory / 12 | 119.2s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 36 |
| B03 | directory / 12 | 121.1s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 28 |
| C01 / C01R | core default | 163.5s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 28 (583 samples) |
| C02 / C02R | core default | 136.6s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 31 (491 samples) |
| C03 / C03R | core default | 141.1s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 30 (508 samples) |
| D01 | configured pg gate / 4 forks | 3.6s | not selected | green, 2 files / 10 pass | 100/97; not sampled |
| D02 | configured pg gate / 4 forks | 3.7s | not selected | green, 2 files / 10 pass | 100/97; not sampled |


### 13. Handoff-to-review atomicity PostgreSQL setup hook

- **Status:** Active first sighting — recorded 2026-08-23, unattributed.

- **File:** `packages/core/src/__tests__/postgres/handoff-to-review-atomicity.pg.test.ts`
- **Exact test:** `handoff-to-review transactional invariant (PostgreSQL)` suite `beforeAll(h.beforeAll)` setup hook (line 35).
- **Observed tree/SHA:** `39812f4898` (observed locally as `82c37ee3fd`, the same tree before an upstream rewrite) with uncommitted `packages/engine/src/executor/{execute-core,execute-workflow-graph}.ts` changes plus one new engine test. Those changes are engine-only; the subject is a core PostgreSQL file and imports nothing from them.
- **Observed frequency:** 1 sighting, on the FIRST `pnpm test:gate` invocation of the session; not reproduced in 8 subsequent runs across three shapes.

| run | shape | result |
|---|---|---|
| gate (1st of session) | `pnpm test:gate` | **`beforeAll` hook timed out** at the inherited 15s budget; 6 passed / 4 skipped in the lane |
| gate ×2 | `pnpm test:gate` | green, 715 tests each (4 lanes: 200 / 433 / 10 / 72) |
| pg-gate ×3 | `pnpm --filter @fusion/core run test:pg-gate` | 2 files / 10 tests passed each run |
| isolated ×3 | target file alone, `vitest.pg.config.ts` | 1 file / 4 tests passed each run |

**Evidence gap disclosed:** the original failing run's output was piped through `tail`, so only the summary and the `FAIL` identity lines survive; the full runner output was not retained. The identity is unambiguous (file, suite, `beforeAll` hook, 15s budget, `:35:3`), but this record cannot supply a full log for the failing run. The eight verification runs above were captured in full.

This is the same mode already characterized by entry 6 and by entry 7's A02 lane: a 15s `beforeAll` abort on the DDL-heavy per-file schema-template setup that the one shared Postgres serializes. Two properties make this sighting narrower than the shapes those entries measured. It occurred under the CAPPED gate lane — `PG_MAX_WORKERS = 4` and only two selected files — which `FNXC:PgTestWorkerCap 2026-07-18-18:00` established as the DB-safe ceiling (measured: 6 forks all time out, 4 forks pass in ~42s). And it occurred on the first gate invocation after the cluster had been idle, with every later run in the same shell green, which points at cold-cluster startup cost landing inside the first file's setup budget rather than at fork oversubscription. That correlation is a HYPOTHESIS, not a measurement: reproducing it means stopping the embedded cluster, which was not done because this host also runs a live Fusion instance.

Quarantine was not available as an alternative. Core PostgreSQL files cannot be quarantined inline — the gate-policy assertion requires `quarantinedCoreTests` to remain empty — and a merge-gate eviction of a transactional-invariant file is the owner-escalated decision described in the policy section below. The file carries only 4 tests, which is thin against the usual first-sighting coverage argument, but they are the atomicity invariant for handoff-to-review and one of just two files in the blocking PG lane; recording preserves that rather than trading it away over a single unreproduced cold-start abort. A **second sighting** follows normal escalation.


### Common shape and investigated result

FN-9125 established that former entry 3 was not PostgreSQL-suite-adjacent: `plugin-runner.test.ts` used an in-memory mocked TaskStore and had no PostgreSQL/harness import. FN-9135 did not identify a root cause, but FN-9141's completed shuffled worker-reuse campaign reproduced and structurally fixed the logger mock-history fixture defect; the suite and its renamed-complete-lane dispatch coverage remain active. Entries 2 and 7 remain active, unreproduced PostgreSQL observations: FN-9146 completed the later A×4/B×3/C×3 campaign without either exact identity failing. Entry 1 reproduced under FN-9126 and again under FN-9146's A02–A04 lanes, but remains unattributed rather than structurally fixed. The golden-template/advisory-lock lifecycle and schema-applier's inline baseline path are concrete architecture facts, not a demonstrated cause of these assertions. Core policy forbids inline PG quarantine: FN-9146 owns the retained evidence for entries 1, 2, and 7; no source or fan-out change is justified before a diagnostic names a causal lifecycle seam. Entry 13 is a further unreproduced instance of that same 15s setup-hook mode, narrowed to the capped four-fork gate lane on a cold cluster. Entry 6 instead records a merge-gate eviction after a loaded-lane setup-hook timeout; `FNXC:PgTestTemplateDb 2026-07-19-17:20` and `FNXC:PgTestWorkerCap 2026-07-18-18:00` are already-landed mitigations for that mode, not new diagnoses to re-open. The Planning Mode entries are separate frontend timing observations.



## Merge-gate eviction records

### 6. Sync workflow IR default canary setup hook

- **Status:** Merge-gate eviction 2026-08-16 by FN-8928.

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

## Policy and escalation

Quarantine is file-level, while the first-sighting exception preserves coverage in files retaining 6 / 75 / 80 passing tests. Under that exception, recording preserves valuable coverage. A **second sighting** of a registered test is an on-sight quarantine: add it to `scripts/lib/test-quarantine.json` and the matching Vitest `exclude` in one lockstep commit; this register entry is then evidence for the ledger `reason`.

Merge-gate eviction records follow a separate branch: the gate can no longer be reddened by that file, while the non-blocking suite retains coverage. A further failure there is an ordinary on-sight quarantine. For PostgreSQL files, the gate-policy assertion forbidding a core-config quarantine exclude makes that an owner decision escalated as its own task rather than an inline edit.

Capture **full runner output** before recording or quarantining a failure—for example, tee it to a file. Never pipe a dot reporter through `tail`: the summary survives while the `FAIL` identity lines needed for a quarantine entry are exactly what gets truncated.

Source: [Runfusion/Fusion issue #2862](https://github.com/Runfusion/Fusion/issues/2862).



## Archive — closed records

Archived records are historical evidence only and never authorize a quarantine decision.

### 3. Plugin runner complete-lane lifecycle hook

- **Status:** Closed 2026-08-17 by FN-9141 — rescued (fixture defect).

- **File:** `packages/engine/src/__tests__/plugin-runner.test.ts`
- **Historical exact test:** `PluginRunner > task lifecycle hooks > should invoke onTaskCompleted when the complete lane is RENAMED`
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

**Rescued 2026-08-17 (FN-9141):** FN-9141 completed the terminal new-strategy campaign with shuffled files/tests, worker reuse without per-file isolation, and a temporary byte-for-byte repeated subject. The completed two-worker lane reproduced a named test-fixture defect: a neighbouring worker-reused file can call `vi.clearAllMocks()` after `PluginRunner` has initialized, erasing `createLogger.mock.results` before the hot-reload warning assertion reads it. The assertion already catches the real `stopPlugin` rejection/warning contract; the repair keeps its logger instance in a hoisted stable reference and explicitly proves cleanup cannot erase that reference. The ledger row and default-lane exclusion remain removed together. No timeout, retry, assertion weakening, skip, polling, or permanent worker-policy change was used.

| FN-9141 new-strategy reproduction | seed | workers | isolation | duration | subject result | whole-lane result |
|---|---:|---:|---:|---:|---|---|
| shuffled, worker-reuse loaded engine-default | 914141 | 2 | disabled / worker reuse | 900.1s (campaign bound) | 82 passed | terminated before summary; unrelated `project-engine` timeouts after subject completed |
| shuffled, repeated-subject loaded engine-default | 914142 | 8 | enabled; temporary byte-for-byte subject repeat | 222.66s | original 82 passed; repeat 82 passed | complete: 48 failed / 787 passed / 1 skipped files; 117 failed / 11230 passed / 14 skipped / 1 todo tests; no subject failure |
| shuffled, worker-reuse, repeated-subject loaded engine-default | 914143 | 2 | disabled / worker reuse; temporary byte-for-byte subject repeat | 1548.60s | reproduced one hot-reload warning fixture failure; repeat passed | complete: 224 failed / 611 passed / 1 skipped files; 1801 failed / 9534 passed / 26 skipped / 1 todo tests; unrelated loaded failures also present |

The rescue retains plugin loading, contribution accessor, runtime compatibility, hot-reload, and lifecycle-hook assertions, including the renamed-complete-lane `onTaskCompleted` dispatch that would have been uniquely lost under deletion. The direct regression now covers the worker-reused cleanup sequence that caused the reproduced warning assertion failure.

### 4. Planning Mode direct task handoff

- **Status:** Closed 2026-08-10 by FN-8936 — superseded.

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

### 5. Planning Mode mobile plan-tab selection

- **Status:** Closed 2026-08-10 by FN-8936 — suite re-admitted.

- **File:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
- **Exact test:** `PlanningModeModal sequential flow > uses full-view Questions and Plan preview tabs on mobile`
- **Observed tree/SHA:** `main` at `4ff41a723c` with the Planning Mode task-creation fix uncommitted.
- **Observed frequency:** first observation in a targeted three-file dashboard run.

| run | result |
|---|---|
| targeted three-file dashboard run | **1 failed** / 198 passed; React reported an update outside `act(...)`, and the Plan tab still had `aria-selected="false"` immediately after `fireEvent.click` |

The failure exercises the pre-existing mobile tab transition, while the task-creation fix changes the completed-plan Proceed handoff. The file retains substantial coverage, so this first sighting is recorded rather than quarantined; a second sighting requires the normal file-level quarantine.

**Suite re-admitted 2026-08-10 (FN-8936):** This first-sighting mobile observation did not receive a second failure. The shared file-level quarantine was removed only after the direct-handoff root cause was structurally fixed and the unexcluded loaded suite, including this mobile coverage, passed.

### 8. Planning Mode duplicate-response generation reconciliation

- **Status:** Closed 2026-08-16 by FN-9116 — resolved (product race).

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

### 11. Settings revision attribution reset-ordering assertion

- **Status:** Closed 2026-08-16 by FN-9129 — resolved (reset-ordering assertion).

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

### 9. Create Room picker loaded-lane state ordering

- **Status:** Closed 2026-08-16 by FN-9120 — resolved (product race).

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

### 10. Planning Mode loaded-turn affordance ownership

- **Status:** Closed 2026-08-16 by FN-9117 — resolved (product ownership race).

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

### 12. Satellite approval audit lifecycle ordering assertion

- **Status:** Closed 2026-08-16 by FN-9132 — resolved (product ordering defect).

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

**Terminal negative 2026-08-17 (FN-9131):** The reproduced 27-worker PostgreSQL-directory symptom was investigated with a cluster-shared connection-budget primitive. The first harness wiring and a follow-up that queued registry over-subscription while retaining leases both made the loaded run worse (135 failed files in 174.1s, then 144 failed files in 223.3s); the subject itself was not the only failure. The harness wiring was reverted, the primitive remains characterized independently, and FN-9139 owns a setup-safe admission boundary. No quarantine, timeout change, test retry, skip, worker cap, or assertion change was made.

---

## Entry: `self-healing-pending-wedge-notification` marker-selection count (first sighting)

- **File:** `packages/engine/src/__tests__/self-healing-pending-wedge-notification.test.ts`
- **Exact test:** `reconcile pending wedge notifications > selects elapsed markers and audits the completion outcome verbatim`
- **Owner:** unowned — first sighting, recorded rather than quarantined because the file's remaining coverage (4 tests over the pending-wedge reconciler) is substantial and quarantine is file-level.
- **Observed tree/SHA:** `ea48af7ab5`, during a full `@fusion/engine` suite run while auditing pre-existing failures.
- **Observed frequency:** once, suite-only. Passes deterministically in isolation.

Verbatim observed failure:

```
FAIL  |engine-default| src/__tests__/self-healing-pending-wedge-notification.test.ts > reconcile pending wedge notifications > selects elapsed markers and audits the completion outcome verbatim
AssertionError: expected 2 to be 1 // Object.is equality
 ❯ src/__tests__/self-healing-pending-wedge-notification.test.ts:50:62
```

| run | result |
|---|---|
| full engine suite (967 files), `ea48af7ab5` | **failed** with the verbatim count assertion |
| same file in isolation, same tree | **passed** (4/4) |
| full engine suite, baseline `3f448f7292` | not observed |

Reads as cross-test state bleed into the reconciler's marker selection (an expected-1 selection saw 2),
not a timing wait — so no timeout, retry, or assertion change was made. A SECOND sighting is an
ordinary on-sight quarantine with no further discretion, per the standing rule in AGENTS.md.

---

## Entry: `spec-drift-reconciler` exponential-backoff case (first sighting)

- **File:** `packages/engine/src/__tests__/spec-drift-reconciler.test.ts`
- **Exact test:** `SpecDriftReconciler > backs a persistent outage off exponentially instead of re-firing every second`
- **Owner:** unowned — first sighting, recorded rather than quarantined because the file's other 9–13 tests are substantial coverage and quarantine is file-level.
- **Observed tree/SHA:** `a97aa84a20`, full `@fusion/engine` suite run.
- **Observed frequency:** once in a full-suite run; also failed once when run in the same command as `self-healing-pending-wedge-notification.test.ts`, and passes deterministically alone (10/10) and in other pairings.

Verbatim observed failure context:

```
FAIL  |engine-default| src/__tests__/spec-drift-reconciler.test.ts > SpecDriftReconciler > backs a persistent outage off exponentially instead of re-firing every second
```

Both this and the quarantined `self-healing-pending-wedge-notification` case are timer-driven
reconciler tests that fail only alongside other suites, which points at shared fake-timer or
cross-file state rather than a product defect. No timeout was widened, no retry added, and no
assertion relaxed. A SECOND sighting is an ordinary on-sight quarantine with no further discretion,
per the standing rule in AGENTS.md.

**Corroborating observation (identity branch, 2026-08-14):** independently seen once in a full
`engine-default` run (821 files) and not reproducible in isolation (4 passed), on a tree where the
file itself was unmodified. Same file, same suite-only signature as the entry above; recorded here
rather than as a separate entry so the sighting count stays honest.

---

## Entry: `PlanningModeModal.planning-flow` under dashboard lane sharding (first sighting)

- **File:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
- **Exact tests:** a DIFFERENT case failed on each of two consecutive full-lane runs —
  `PlanningModeModal sequential flow > keeps the newer session when delayed duplicate reconciliation returns 'a durable question' on 'mobile'`, then
  `PlanningModeModal sequential flow > can refine a stopped initial plan into the first question`.
- **Owner:** unowned — first sighting for this file. Recorded rather than quarantined: the file carries 83 tests and quarantine is file-level.
- **Observed tree/SHA:** `c82e420ba0`, via the package's real command `pnpm --filter @fusion/dashboard test` (the `run-quality-tests.mjs` lane runner), lane `app:backfill-3` (`--project dashboard-app-quality-backfill --shard=3/4`), concurrency 2, 6144MiB heap per lane.
- **Observed frequency:** twice in two full-lane runs, each time a different case; passes 83/83 in isolation every time.

Verbatim observed failure (second run):

```
FAIL  |dashboard-app-quality-backfill| app/components/__tests__/PlanningModeModal.planning-flow.test.tsx > PlanningModeModal sequential flow > can refine a stopped initial plan into the first question
TestingLibraryElementError: Unable to find an element by: [data-testid="planning-plan-review"]
```

| run | result |
|---|---|
| lane runner, default (fail-fast), `c82e420ba0` | **failed** on the delayed-duplicate-reconciliation case |
| lane runner, `--all --no-fail-fast`, same tree | **failed** on the refine-stopped-plan case |
| isolated `vitest run <file>`, same tree, repeatedly | **passed** 83/83 |

The moving target plus a "cannot find element" shape points at render/settle timing under a loaded
shard, not a product defect — a wait that is adequate on an idle machine and not under four
concurrent 6GB lanes. No timeout was widened, no retry added, no assertion relaxed. A SECOND sighting
of the *same* case is an ordinary on-sight quarantine per the standing rule in AGENTS.md; because the
case moves, the honest rescue is a deterministic settle signal in this file's harness rather than a
longer wait.

---

## Entry: dashboard `api:backfill-*` lanes — PostgreSQL contention under lane concurrency (pattern, not a single test)

- **Files:** no fixed set. Across three consecutive full-lane runs on the same tree, a DIFFERENT file failed each time:
  - run 1: `app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
  - run 2: `src/__tests__/routes-branch-groups.test.ts`, `src/__tests__/routes-planning.test.ts`
  - run 3: `src/__tests__/register-signal-routes.test.ts`, `src/__tests__/server-view-preload.test.ts`
- **Command:** `pnpm --filter @fusion/dashboard test -- --all --no-fail-fast` (the `run-quality-tests.mjs` lane runner: 15 lanes, concurrency 2, 6144MiB heap per lane).
- **Observed tree/SHA:** `cc19584cc4`.
- **Every one passes in isolation**, including re-running the exact multi-file command that had just failed.

Failure shape in run 3 (`api:backfill-1`, `api:backfill-2`):

```
Error: Hook timed out in 15000ms.
fnlvl=warn [dashboard-github-tracking-reconciler] … pass failed (other passes still run): Failed query: select … from "project"."tasks" …
```

The hook timeout arrives alongside PostgreSQL `Failed query` warnings, so the proximate cause is
database contention/exhaustion when two api lanes and their workers share one PostgreSQL instance —
the same class FN-9131 investigated for core's loaded PostgreSQL directory, where a shared
connection-budget primitive made a loaded run WORSE and was reverted. This is suite infrastructure,
not a defect in any of the five files above, and chasing the file that happened to lose the race on a
given run is whack-a-mole.

Scale for context: run 3 executed roughly 15,200 tests across 15 lanes and failed 2.

**Not quarantined deliberately.** Quarantine is file-level and the failing file moves, so quarantining
would evict healthy coverage without touching the cause. The rescue is a connection/concurrency budget
for the api lanes (or per-lane database isolation), owned by whoever owns the lane runner. No timeout
was widened, no retry added, and no assertion relaxed anywhere in this investigation.

One genuinely structural failure WAS found and fixed rather than recorded here: the lane runner's own
self-tests spawned `pnpm --filter @fusion/dashboard test`, re-entering the suite from inside it. See
`cc19584cc4`.
