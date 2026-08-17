---
category: test-failures
module: testing
date: 2026-08-16
problem_type: suite_only_flake
component: PostgreSQL test harness
severity: medium
applies_when:
  - "Parallel PostgreSQL tests contend on CREATE or DROP DATABASE"
tags:
  - postgres
  - ddl
  - concurrency
---

# Bound PostgreSQL test DDL with advisory admission slots

FN-9127 recorded 30 `dropDatabase` watchdogs (maximum 3,582ms) at 12 workers. PostgreSQL `DROP DATABASE` forces an immediate cluster checkpoint and `ProcSignalBarrier`, so concurrent drops queue at server-global serialization points. FN-9130's three local 12-worker baselines recorded 13 more watchdogs and 3,284ms maximum completed drop time.

The initial uniform K=4 gate was a measured non-remedy: it pooled creates with drops and produced 49 watchdogs with a 5,068ms maximum completed drop, versus the 4–5 watchdog / 3,284ms baseline. Its scratch timing rerun attributed 513.9s of aggregate gate-plus-DDL time to 747 drops (mean 687.9ms, p95 1,880.7ms) and 200.1s to 379 creates (mean 528.1ms, p95 1,310.1ms). Creates consumed 28% of the pooled region time despite not forcing a checkpoint.

A statement-scoped K=4 **drop-only** candidate was then measured: `DROP DATABASE` was admitted while plain/template `CREATE DATABASE` ran directly under PostgreSQL's default `WAL_LOG` strategy. It still produced 27 watchdogs and a 3,361ms maximum, so it too was rejected. The harness wiring is now direct; server-side session advisory locks and the per-fork ledger remain as independently tested infrastructure only. Each admission session is reused on maintenance `postgres`, because a test-database session could be terminated by sibling `DROP DATABASE ... WITH (FORCE)`.

A local ledger is equally necessary. Repeated `pg_try_advisory_lock` calls by the same PostgreSQL session return true and increment a count. Step 0 confirmed: acquire=true, acquire=true, first unlock=true, another session sees false, second unlock=true. The ledger claims an unclaimed slot before asking PostgreSQL, preventing concurrent work in one fork from double-booking a counted lock. `AsyncLocalStorage` detects and rejects reentrant regions: inherited context cannot distinguish an immediately-awaited child from parallel spawned children, so slot reuse would violate the K-slot bound.

Lock order is golden marker lock → golden build lock → module-local template copy chain → one DDL admission slot. The slot is never held across outer-lock waits, baseline application, or retry sleep. Holding it while waiting for the golden lock can deadlock all K holders against the build winner.

Admission failure is fail-open but observable: `degradedCount` and one warning per reason record a connection/acquisition/session-loss exception. Degradation is not a satisfied bound; proof and loaded-measurement lanes require zero degradation. At 12 workers the conservative 48-connection estimate (store pool 2, transient admin/maintenance, one admission session per fork) leaves 52% headroom below this cluster's `max_connections=100`.

The prospective K=4 queue arithmetic was 7.6s at the measured 1.88s p95, below the 10s admission deadline. The prospective 12-worker connection estimate was 48 (`12 × (store pool 2 + one transient admin/maintenance client + one admission session)`), 52% below `max_connections=100`; neither fact overcame the measured watchdog regression. Reverted harness measurements were green at 120.9s, 114.3s, and 118.1s with 3, 4, and 10 watchdogs respectively (max drops 3,345ms, 3,082ms, and 3,041ms), so they also did not establish a stable 4–5-watchdog baseline. A final direct-harness campaign likewise passed all files but varied from 1 to 17 watchdogs (105.1s/3,007ms, 124.6s/3,323ms, and 122.1s/3,407ms). This is an honest unresolved negative result, not a shipped structural bound.

FN-9130 then implemented bounded deferred draining (R=2, Q=8), per-file flush, and a dead-pid sweep. It structurally zeroed hook-inline drop watchdogs, but this is explicitly not acceptance evidence. The first 12-worker run leaked one database because root setup's `afterAll` ran before a shared harness registered its teardown; adding a shared-harness flush eliminated that leak. The next two green runs took 117.2s and 122.4s, already slower than the 108.1s baseline maximum; a fourth took 143.8s and timed out in `workflow-events-outbox.pg.test.ts` setup and `pg-test-harness-template-concurrency.pg.test.ts`. The wiring was reverted. This is a measured non-remedy, not a timeout/quarantine change.

Candidate C, per-fork database reuse with `TRUNCATE`, remains unexplored and is filed as FN-9136. Lowering workers, widening timeouts, drop retries, and core-test quarantine were not remedies and were not used.
