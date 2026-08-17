---
category: test-failures
module: testing
problem_type: loaded-postgresql-capacity
applies_when: PostgreSQL harnesses time out or lose connections under high Vitest fork fan-out.
tags: [postgresql, vitest, harness, connection-budget, fn-9131]
---

# PostgreSQL harness connection-budget terminal negative

FN-9131 reproduced the project-identity loaded-lane symptom with 27 workers on a local PostgreSQL 15.15 cluster (`max_connections=100`, `superuser_reserved_connections=3`). The original subject passed, but the PostgreSQL directory run failed broadly: the first budget wiring failed 135 files in 174.1 seconds, and the queueing/lease-retention revision failed 144 files in 223.3 seconds. Neither result is acceptable evidence for shipping harness admission.

The experimental primitive remains available but is deliberately **unwired** from `pg-test-harness.ts`. It derives a closed server-shared advisory-lock space: a backend is one slot; the default minimum harness cost is runtime pool + dedicated migration pool + admin pool (`1 + 1 + 1 = 3`); template construction requires three funded slots; a participant's reserve is six work slots plus a lease slot. On the measured cluster that yields 85 usable slots, a floor cost of seven, and 12 participants. At P=27, oversubscription is normal and must queue rather than throw.

The primitive uses a fixed advisory-lock class ID, separate lease/work bands, conservative degraded derivation, and a fixed-name atomic-directory bootstrap token gate. Node v26.3.0 has no `fs.flock`, `fs.flockSync`, or `O_EXLOCK`; the token is therefore payload-free, reclaimed only after `TOKEN_STALE_MS`, and is not correctness-critical. A failed bootstrap connection closes before retry. The degraded floor must never be raised to a typical cluster value. FN-9130's DDL admission key remains separate and unwired.

The initial wiring exposed two implementation defects: bounded registry retries threw `PgConnectionBudgetConcurrencyError` into tests, and failed reservations released their lease, creating bootstrap/lease thrash. FN-9131 changed the primitive so registry contention queues and retains only a lease during a reserve retry; local ledger failures remain the only `PgConnectionBudgetConcurrencyError` case. That repaired the local primitive but not the loaded harness outcome.

A setup-module top-level admission was not shipped: the shared setup module is loaded by core unit and engine workers with no PostgreSQL harness participants, so it has no per-worker PostgreSQL-suite signal and would consume cluster slots in unrelated lanes. This violates the required inertness condition. FN-9139 owns finding a lifecycle boundary that admits only actual PostgreSQL harness participants off the individual 15-second test budget before the registry is reconsidered.

No timeout, retry, skip, assertion weakening, quarantine, or worker-cap change was made. The dedicated primitive tests remain as characterization; loaded harness connection admission must remain unwired until a successor demonstrates the 27-worker and concurrent gate shapes without a wall-time regression.
