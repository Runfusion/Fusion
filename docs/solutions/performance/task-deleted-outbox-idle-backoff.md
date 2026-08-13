---
category: performance
module: packages/core/src/task-store/task-deleted-outbox-consumer.ts
date: 2026-08-13
problem_type: performance
severity: high
applies_when:
  - "Seeing a setInterval(5s) outbox poll storm peg CPU across many per-project consumers"
  - "A per-project pause does NOT stop a task-store-level poller because the poller is bound to the task store, not the engine pause"
  - "task_lifecycle_consumer_cursors idx_scan growing nonstop (~26/s) on idle/paused projects with a zero cursor delta"
component: task-store
tags:
  - performance
  - poll-storm
  - idle-backoff
  - task-lifecycle-consumer
  - outbox
  - fnxc-crossprocessdeleteobservation
  - fnxc-tasklifecycleconsumeridlebackoff
related_components:
  - task_store
  - lifecycle_outbox
  - dashboard
  - engine
---

# Task-lifecycle outbox idle backoff (the RUFU-074 poll storm)

## Symptom

Production CPU stayed at **70–98%** and the health API took **0.77–2.0s** even after every project was
paused. `pg_stat_user_tables` showed `project.task_lifecycle_consumer_cursors.idx_scan` growing
**~26/s nonstop** with a zero `last_acked` delta while paused. A `cpuprofile` showed
`onStreamRead@?:166` (the stream/DB polling) dominant plus ~76% in the error/promise machinery.

Root cause (measured): **44 lifecycle consumers** run nonstop in the single node process — 22×
`dashboard` + ~20× `engine` (verified in `project.task_lifecycle_consumer_registrations`). Each
registers via `createTaskStoreForBackend` with a **fixed 5s `setInterval`** poll. These pollers live
at the **task-store level** (per InProcessRuntime per project + dashboard store cache), NOT the
per-project engine pause — so **project pause never stops them**. A paused project stops writing
lifecycle events, but the consumers kept polling the same empty outbox every 5s, re-reading the cursor
and re-running Drizzle SQL string compilation forever.

## The chosen fix: idle backoff + jitter inside the outbox consumer (Option 1)

We deliberately chose **idle backoff with jitter inside `TaskDeletedOutboxConsumer`** (the operator's
Option 1) over the alternatives:

- **Option 2** (evict/stop dashboard project stores for paused projects) — risks breaking live
  SSE/real-time cross-process observation and adds coupling to the engine pause system.
- **Option 3** (deregister the engine consumer on project pause) — same coupling concern.
- **Option 4** (gate dashboard store creation on `project.status active` + only the open board
  project) — changes store lifecycle semantics for no benefit.

A paused/idle project stops writing lifecycle events, so its outbox naturally goes empty and **idle
backoff alone** yields the required CPU/idx_scan drop without touching delivery semantics. The fix
lives entirely at task-store level, so it covers both the `dashboard` and `engine` consumers for every
project automatically.

### The rescheduling loop

The consumer no longer uses a fixed `setInterval(5s)`. It now **self-reschedules with a `setTimeout`**,
feeding each poll's outcome back into the next delay:

- **Idle poll** (outbox empty / cursor not advancing): `idlePollsSinceEvent` increments, and the next
  delay grows by `TASK_DELETED_OUTBOX_BACKOFF_STEP_MS` (10s) per idle poll, toward
  `TASK_DELETED_OUTBOX_MAX_POLL_MS` (60s):
  `5s → 15s → 25s → ... → 60s` (capped).
- **Active poll** (delivered ≥1 event): `idlePollsSinceEvent = 0`, next delay resets to the fast
  `TASK_DELETED_OUTBOX_POLL_MS` (5s) base — so a new event mid-backoff is still delivered promptly.
- **Jitter:** `applyPollJitter` applies ±20% multiplicative jitter so the ~44 consumers de-synchronize
  and don't thunder on the same cadence; the delay never falls below the fast 5s base.

### Contract preserved

The `FNXC:CrossProcessDeleteObservation` contract is preserved exactly. Backoff only changes **when**
`poll()` runs, never the `poll`/`dispatch`/`ack` logic:

- Cursor fencing via `advanceCursorWithFence` / fenced `acknowledgeTaskLifecycleEvent(fencingToken)`.
- Lease advance via `renewTaskLifecycleLease`.
- Per-event ordering (in-order sequence advance).
- At-least-once delivery in the crash window (dispatch before durable receipt/ack; `stop()` disarms the
  rescheduled timer so not orphaned poll survives shutdown).

## Verification

Regression test `packages/core/src/__tests__/task-deleted-outbox-consumer-backoff.test.ts` (in-memory
fakes + fake timers, no real DB, no waits) proves:

1. An idle `dashboard` consumer polls far below the fixed-5s rate and reaches the 60s cap, with
   bounded jitter.
2. An active `engine` consumer keeps the fast 5s cadence while delivering events (fenced acks).
3. An idle engine consumer backs off **independently** from a concurrent active dashboard consumer.
4. A burst arriving **mid-backoff** is delivered in order with fenced acks (`fencingToken` honored,
   sequence `1n,2n,3n`) and resets the cadence to the fast 5s base.
5. `stop()` disarms the timer (no orphaned post-stop poll).
6. The deterministic growth curve `5s→15s→...→60s` holds and never falls below base.

## Symptom-verification (operator deploy)

The production :4040 daemon is the Fusion host this agent runs inside; restarting it crosses the
shutdown boundary and the embedded PG global dir is privilege-fenced from agent sessions. Use the
handoff script `scripts/deploy-rufu-074.mjs` (operator-run) to measure before/after:

- **Before baseline** (old build): `task_lifecycle_consumer_cursors.idx_scan` growth, daemon CPU,
  health latency.
- **After** (new build): same three measures.
- **Targets:** idx_scan < 5/s, CPU < 50%, health < 0.5s.