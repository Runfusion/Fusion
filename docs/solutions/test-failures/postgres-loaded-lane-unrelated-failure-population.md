---
category: test-failures
module: testing
problem_type: loaded_postgresql_timeout_population
applies_when:
  - "The 27-worker core PostgreSQL directory lane reports unrelated hook or test timeouts"
  - "A PostgreSQL loaded-lane remedy is proposed from runner-log impressions"
tags:
  - postgres
  - vitest
  - diagnostics
  - timeout
  - census
---

# PostgreSQL loaded-lane unrelated failure population

## Verdict: reproduced, but attribution remains coverage-limited

FN-9148 reproduced the unrelated population in three of five pre-registered,
diagnostics-enabled 27-worker directory runs. A03/A04/A05 reported 45, 35, and
32 failed files respectively, while their observed peaks were 63, 75, and 71
backends below the 97 ordinary-slot ceiling. This establishes the fan-out
symptom; it does not establish a cause or authorize a harness remedy.

## Method

`scripts/pg-loaded-failure-census.mjs` is a cluster-free parser. It reads a
retained Vitest runner log and teardown-diagnostics JSONL, then reports every
failing file, its lifecycle position and shape, snapshot peak/headroom, waits,
phase-duration statistics, and watchdog/probe-degradation counts. It labels
campaign subjects rather than excluding them. A missing `Test Files` summary
is `insufficient-data`; a complete passing summary is a measured zero-failure
run.

The host had 28 CPUs, so requested 27 workers resolved to 27. PostgreSQL was
15.15 with `max_connections=100`, three reserved connections, 128MB
`shared_buffers`, a five-minute checkpoint timeout, and 1GB maximum WAL. Test
databases were enumerated and explicitly reset between primary samples.

| lane | outcome |
|---|---|
| 27-worker directory A01–A05 | red: 13, 24, 45, 35, 32 failed files; peaks 73, 61, 63, 75, 71 |
| 12-worker directory | green, measured zero failures |
| isolated `project-identity.test.ts` | green, measured zero failures |
| configured four-fork PG gate | green, measured zero failures |
| default core lane | green, measured zero failures |

The reproduced runs mixed setup/teardown and body timeouts. A03, for example,
had four beforeAll, 19 afterEach, five afterAll, and 17 body failures; its
watchdog snapshots included checkpoint, ProcSignalBarrier, and object-lock
waits. The checkpointed task document `evidence` is the detailed durable
record.

## FN-9149 timeout-boundary observation

FN-9149 added a default-off setup/body/teardown observer and ran its enabled-wiring gate before the campaign. The gate emitted full, non-suppressed watchdog payloads at all three boundaries, including `shared.body`; it used only observer environment settings (1ms per-boundary watchdogs, 1500ms probe timeout, 1200ms statement timeout, 2000ms drain, max probes 20, concurrency 3). The raised cap and concurrency were gate-only; campaign runs retained concurrency 1 and queue timeout 0.

The original I01–I03 samples (14, 31, and 52 failures; peaks 66, 68, and 70) and unset control (27 failures; peak 70) remain retained as superseded: their 12s watchdog was coverage-limited and the original 25% population rule flagged perturbation.

Before any J-series invocation, FN-9149 prospectively amended the registration. FN-9148’s fixed baseline dispersion was 13/24/45/35/32 (range 32, or 71.1% of the 45-file maximum), so the J-only perturbation threshold is conservatively rounded to 72% of the larger population. The fixed amended observer stack used 14s setup/body/teardown watchdogs (strictly below the 15s inherited budgets and above the measured healthy gate maximum), threshold 2s, probe/statement/drain 1500/1400/3000ms, cap 4, concurrency 1, and queue 0. The forced gate’s raised cap/concurrency remained gate-only.

The J-series completed three instrumented runs and an unset-observer control: J01=47 failures, peak 58; J02=26, peak 79; J03=54, peak 67; control=40, peak 70. Their enabled/control differences (7/14/14) are below the prospectively fixed 72% limits (34/29/39), so the J instrumented output is not perturbation-flagged. All peaks remain below the 97 ordinary-slot ceiling. J01/J02/J03 joined 9/2/1 cluster-implicated failures and left 38/24/53 unjoined; no watchdog probe was suppressed and one record per run settled during its probe. This remains insufficient body and boundary coverage for M2–M4 attribution, not evidence for a remedy. Full JSONL/census and the retained prior sample are checkpointed in FN-9149’s `evidence` document.

The superseded 12s clean/dirty arm remains retained but cannot decide M5. The required amended-stack arm then ran interleaved `clean → dirty → clean → dirty` as J04–J07. Clean J04/J06 began with zero matching leftovers and reported 29/36 failures (peaks 79/68; cluster/unjoined=0/29 and 3/33). Dirty J05/J07 deliberately retained one `fusion_test_%`, two `fusion_schema_template%` databases (including a live-owner golden template), and one `fusion_pool_%` database; they reported 43/50 failures (peaks 88/65; cluster/unjoined=6/37 and 2/48). All four used the fixed J observer stack and were retained; J05's 13 `cap` suppressions limit boundary attribution but do not erase the independently repeated clean/dirty failure-count covariation. The monotonic watchdog-drift host sample was nonzero on 4/4, 114/130, 19/20, and 26/28 watchdog records respectively (max 3/18/10/4ms), so this arm does not support host-starvation attribution. Final cluster hygiene was restored to zero matching test, pool, and schema-template databases.

## Discrimination table

| mechanism | verdict | evidence / missing discriminator |
|---|---|---|
| M1 ordinary backend exhaustion | eliminated (generic ordinary-slot form) | A01–A05 and J01–J03 peaks were 58–79, all below the 97 ordinary ceiling; no per-user/database limit was observed. A successor must separately measure any scoped limit before claiming that variant. |
| M2 DDL serialization | still undecided (missing evidence: join coverage) | Twelve J watchdog joins cannot correlate DDL/locks to 127 failures. |
| M3 golden-template/advisory convoy | still undecided (missing evidence: joined golden-lock waiters) | The probe now records granted holders and non-granted golden advisory waiters; no sufficient joined timeout population exists. |
| M4 host CPU/event-loop starvation | still undecided (missing evidence: join coverage) | The observer now records watchdog scheduling drift rather than a fixed zero, but the campaign cannot distinguish idle-cluster host starvation from blocked SQL at required body coverage. |
| M5 dirty-cluster carryover | still undecided (underpowered descriptive covariation) | J04–J07 covaried at 0 leftovers → 29/36 failures and 1 test + 2 schema-template (one golden) + 1 pool leftover → 43/50 failures. FN-9150's prospectively configured clean/dirty pair was 60/42 failures, respectively, but n=1/arm is below the 7/arm Δ=20 target. Neither result is an M5 verdict; FN-9152 owns the powered arm. |

## FN-9150 timeout-boundary coverage diagnosis

M01 was a clean-start 27-worker measure-first run with a 1,000ms ladder, threshold 0, one probe maximum, and the 12,000ms watchdog. It reported 29/176 failing files at peak 70, leaving 27 ordinary slots of headroom. It is elapsed-distribution evidence, not attribution. Setup/body/teardown records were 3,101/804/2,579; terminal maxima were 20,448/1,895/15,013ms and progress-only maxima were 20,099/1,001/14,065ms. Progress rows are lower bounds at 1,000ms resolution and cannot be pooled with terminal elapsed measurements.

The 12,000ms watchdog has at most 3,000ms before the inherited 15,000ms Vitest limit. Its 1,500ms probe timeout and non-negative single-flight queue delay leave at most 1,500ms before scheduling delay and the unobservable Vitest-to-harness offset. M01 captured 30 watchdog results and seven cap suppressions. Of 29 failing files, 14 (48.3%) were consumer `afterEach` failures outside the shared-harness bracket; they are position-unobservable, not observer misses. Four failures (13.8%) had ladder bounds; 11 (37.9%) remained observable-position unjoined. Vitest JSON exposed 1,386 per-test durations but no hook duration or hook failure position; file-level pairing produced invalid negative differences down to -13,971.94ms. The hook-clock offset is therefore unmeasurable on this reporter version, not a point estimate.

FN-9150's two-phase breach row preserves a keyed elapsed record before a probe can be abandoned, while the ladder covers boundaries that never reach the watchdog. Neither row may affirm M2–M4. The real shared-harness gate passed normal, ladder, and forced runs: forced setup/body/teardown records were 10/3/13, with enriched non-suppressed payloads 3/1/4 and a reporter file join. The forced gate is wiring evidence only.

A post-campaign review found that shared-harness body windows reused a file-level key. The observer now emits a unique `joinKey` for every open body window and retains that file-level value only as `supersessionKey`: a terminal record for a later healthy body can no longer mask an earlier abandoned body's progress-only ladder records. The census already groups terminal filtering by `joinKey`; a production-shaped multiple-body regression covers the separation. This is a coverage-integrity correction, not a new sample or an attribution verdict.

The prospective power rule uses A01–A05 σ=12.6 and `2(1.96+0.84)^2σ²/Δ²`: Δ=20 requires seven runs/arm and Δ=10 requires 25. The 12-run self-imposed budget (46.16 minutes at 230.8s/run) cannot power either enabled-vs-unset or M5 after one measure-first and three gate-equivalent runs. The retained J enabled/control and J04–J07 clean/dirty samples are consequently descriptive; no absence or covariation from them is a powered perturbation or M5 verdict.

## FN-9150 corrective campaign — retained outcomes

The fixed campaign stack was pre-registered before its runs: observer threshold 0, ladder 1,000ms, 12,000ms setup/body/teardown watchdogs, 1,500/1,400/3,000ms probe/statement/drain bounds, one concurrent probe, queue timeout zero, and four probes. Every run used 27 workers, teardown diagnostics, JSON reporter capture, and a clean starting cluster unless labelled dirty. The intended two-run-per-arm allocation could not approach the pre-registered n=7/arm Δ=20 requirement; all comparisons below are explicitly **undetermined (underpowered)**.

| lane | failing files | peak / headroom | positions | coverage yield (joined / ladder / position-unobservable / unjoined) | outcome |
|---|---:|---:|---|---|---|
| enabled C1 | 34 | 66 / 31 | afterEach 8; afterAll 9; beforeAll 1; body 16 | 0 / 2 / 8 / 24 | Coverage floor missed; no attribution. |
| unset U1 | 39 | 70 / 27 | beforeAll 5; afterAll 4; afterEach 15; body 15 | 0 / 0 / 15 / 24 | Control retained. |
| enabled C2 | 35 | 70 / 27 | afterEach 15; afterAll 5; beforeAll 1; body 14 | 2 / 0 / 15 / 18 | Coverage floor missed; two joined rows do not identify a mechanism. |
| unset U2 | 66 | 66 / 31 | afterEach 28; afterAll 11; beforeAll 8; body 19 | 0 / 0 / 28 / 38 | Control retained. |
| M5 clean | 60 | 60 / 37 | beforeAll 6; afterEach 31; afterAll 8; body 14; setup 1 | 2 / 5 / 31 / 22 | Clean arm, one `cap` suppression. |
| M5 dirty | 42 | 78 / 19 | body 18; afterAll 5; beforeAll 5; afterEach 14 | 2 / 1 / 14 / 25 | Dirty arm began with one test, one schema-template, and one pool database. |

Enabled mean failure count was 34.5 versus unset 52.5 (difference −18), but n=2/arm is below seven and the pre-declared Welch/rank comparison is not inferential. The 50% joined-plus-ladder coverage floor was missed in both enabled samples (2/34 and 2/35), so enabled rows are a coverage finding, not M2–M4 attribution. No observer probe was concurrency-suppressed in the perturbation lanes; one M5-clean record was cap-suppressed. The M5 clean/dirty difference is 18 failures at n=1/arm and is likewise **undetermined (underpowered)**. Final hygiene after every run was restored to seven backends and zero matching test/template/pool databases.

Payload-free breach and ladder rows remain location-only evidence: they cannot affirm a cluster-state mechanism. The new campaign again keeps every observed peak below the 97 ordinary-slot ceiling, which preserves M1's generic-form elimination. M2–M4 remain undecided because coverage is below floor; the successor needs an executing-test/hook-position join identity or a bracket for the remaining unowned positions, while M5 needs seven interleaved runs per arm under an allocated host budget.

## Remedies disqualified by this evidence

Do not raise timeouts, add retries or skips, alter worker caps, quarantine core
PostgreSQL files, wire the retained connection-budget/admission primitives, or
change DDL paths. Reducing generic connection demand is specifically unsupported:
the reproduced peaks are below ordinary capacity. A green comparison lane is
not a resolution.

## Successor measurement seam

FN-9152 owns the powered dirty-carryover measurement arm: obtain the host budget for seven interleaved clean and seven dirty runs before judging the retained covariation, without changing timeouts, retries, skips, worker caps, quarantine, DDL, connection-budget, or admission behavior. A separate successor may improve timeout-boundary join coverage for M2–M4; it must preserve the default-off observer and repeat the perturbation control. Generic ordinary-slot exhaustion remains disqualified.
