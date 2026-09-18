---
category: performance-issues
module: engine
tags: [dispatch, triage, scheduler, workflow-continuations, admission, latency, event-driven]
problem_type: unexplained-latency
applies_when:
  - a card stays visibly queued after Start while capacity is free
  - planning finishes but Plan Review does not start for seconds
  - a card waiting on capacity does not start when the last slot is returned
  - a mutation written by another process does not wake the local engine
---

# Event-driven task dispatch: removing added waits between action and reaction

## Problem

An operator pressing Start saw the card sit "queued" for a while — sometimes milliseconds,
sometimes seconds — with capacity wide open and nothing blocking. Likewise a card arriving at a
review point did not necessarily start its review straight away. The engine already had wakes,
but several transitions added a fixed wait, dropped a signal, or still depended on a periodic
tick to make progress.

## Root causes (measured as mechanisms, not estimates)

Reproduced in `packages/engine/src/__tests__/event-driven-dispatch.test.ts`, whose only settling
primitive is a microtask drain. A case that needs `advanceTimersByTime` is proving the periodic
backstop rather than the event path, so the clock is never advanced there.

1. **A deliberate 150 ms debounce at planning admission.**
   `TriageProcessor.requestImmediatePoll()` put every wake behind
   `setTimeout(..., NUDGE_DEBOUNCE_MS = 150)`. The comment justified it as burst coalescing for a
   multi-card drag — but coalescing needs *one pending pass*, not a *time window*, so the 150 ms
   was pure added latency on the single-card case that operators actually notice.

2. **Pause resume could lose its signal.** Both `settings:updated` resume handlers
   (`globalPause` and `enginePaused` going true→false) called `this.poll()` directly. `poll()`'s
   re-entrance guard drops the call when a pass is in flight, and only `requestImmediatePoll()`
   records `nudgeDuringPoll`. So an unpause landing during a pass had no effect until the next
   tick.

3. **The `planner-live` deferral was never lifted by its own cause.** The Plan Review continuation
   is legitimately seeded before `specifyTask`'s `finally` removes the task from the planning-owner
   set, so the drain correctly meets `planner-live` and pushes `retryAfter` out by
   `PLANNER_LIVE_CONTINUATION_DEFER_MS` (15 s). Nothing cleared that deferral when the planner
   actually finished — a later wake is useless because the row is no longer due. **This is the one
   cause with a seconds-scale magnitude**, and it explains the operator's "parfois secondes".

4. **`onPlanningSlotReleased` woke only the scheduler**, and carried no task identity, so nothing
   could target the deferral in (3). Continuations fell back to the 2 s interval.

5. **`ProjectAdmissionCoordinator.releaseReservation()` was silent.** Another card made admissible
   by that release was only woken if the departing owner happened to run a pass itself.

## Fix

- `requestImmediatePoll()` coalesces on a **pending flag drained in a microtask**, with no time
  window. Burst behaviour is preserved (N moves → 1 pass); the added 150 ms is gone.
- Both unpause handlers go through `requestImmediatePoll()`, so a resume arriving mid-pass is
  replayed by the existing `nudgeDuringPoll` path instead of being dropped.
- `onPlanningSlotReleased(taskId)` now carries the finished card's id and fires **after** the
  planning work item is closed, capacity is returned, and the owner sets are cleared. The runtime
  reacts by clearing that task's `planner-live` deferral under compare-and-set
  (`wakePlannerLiveDeferredContinuations`) and kicking the continuation consumer.
- `ProjectAdmissionCoordinator.onReservationReleased(projectId, listener)` publishes a
  project-scoped, per-task release signal. Subscribers are isolated (a throwing listener cannot
  break the release) and disposable.
- `TaskStore` publishes a **dispatch-wake signal** for eligibility-relevant publications, locally
  and — on PostgreSQL — across processes with `LISTEN/NOTIFY` delivered **after commit**. Canonical
  task and settings publications reach other processes through a fire-and-forget transport on the
  data layer's existing pooled handle; work-item writers keep publishing inside their own writing
  transaction.
- **One routing key per project.** Publishers and subscribers both resolve it with
  `resolveDispatchWakeProjectKey`, which prefers the partition identity (`AsyncDataLayer.projectId`)
  over the project root, because two processes of one project share the former and never the
  latter. A remote delivery naming an identity the runtime answers to (its wake key or its root) is
  remapped onto the local subscription key; a foreign project keeps its own id and stays filtered.
  Publishing under one key while subscribing under another silently dropped every remote wake,
  including the engine's own notification, and left the 2 s sweep as the real trigger.

## Non-goals, deliberately preserved

- Periodic sweeps stay. Event-driven nominal flow does not mean no repair after a crash or a lost
  notification; the interval is now the *backstop*, not the mechanism.
- No wake is an authorization. Every pause, approval, dependency, lease, `autoMerge:false`, and
  capacity gate still runs at the dispatch point; a wake only decides *when* the existing pass
  looks.
- Genuinely temporal waits keep their deadline: provider retry `retryAfter`, leases, watchdogs,
  and `PARKED_CONTINUATION_DEFER_MS` (a human-latency window).
- No optimistic status. A card that is really waiting still reads as waiting.

## What each cause cost, and what is proven

| Cause | Added wait removed | Proven by |
| --- | --- | --- |
| 1. planning-admission debounce | 150 ms, every admissible start/create/move | `event-driven-dispatch.test.ts` case A, no clock advance |
| 2. lost pause resume | up to `pollIntervalMs` (15 s default) | same file, resume routed through the pump |
| 3. unlifted `planner-live` deferral | up to 15 s, planning → Plan Review | `plan-review-not-concurrent-with-planning.test.ts`, both handoff orders |
| 4. release woke only the scheduler | up to 2 s per published continuation | `event-driven-dispatch.test.ts` case C |
| 5. silent `releaseReservation` | up to 2 s / 15 s for a capacity-blocked card | `event-driven-dispatch.test.ts` case D, real coordinator |

The worst cumulative case (1 + 3) is what produced the operator's "quelques ms parfois secondes".

**Not claimed.** A per-incident timing breakdown on a production host is not measured here. The
evidence above is of MECHANISM — each cause is reproduced, and each fix is asserted without advancing
a clock — not of a wall-clock distribution. PostgreSQL I/O and session startup remain physical costs
and are named as such rather than attributed to the scheduler.

## Legitimate remaining latency

Persistence and commit, the planning lifecycle advisory lock, per-task workflow locks, admission
reads, worktree and session preparation, and the AI provider's own response time. These are
physical costs, named as such, not hidden behind a fake "started" state.

## Targeted verification

**Rule: a healthy-path case may not advance a clock.** Every consumer still has a periodic backstop,
so `advanceTimersByTime` makes a case pass through the backstop and prove nothing about the event
path. Settle with a bounded microtask drain. See `docs/testing.md` → "Event-driven dispatch: no clock
advance in a healthy path".

```bash
pnpm --filter @fusion/engine exec vitest run \
  src/__tests__/event-driven-dispatch.test.ts \
  src/__tests__/dispatch-wake-wiring.test.ts \
  src/__tests__/dispatch-latency.test.ts \
  src/__tests__/triage-planning-wake.test.ts \
  src/__tests__/triage-planning-slot-release-wake.test.ts \
  src/__tests__/plan-review-not-concurrent-with-planning.test.ts \
  src/__tests__/concurrency.test.ts --silent=passed-only --reporter=dot

pnpm --filter @fusion/core exec vitest run src/__tests__/dispatch-wake.test.ts \
  --silent=passed-only --reporter=dot

# Cross-process guarantees are the SERVER's, so they are pinned against a real PostgreSQL.
FUSION_PG_TEST_URL_BASE=postgresql://postgres:postgres@localhost:5432 \
  pnpm --filter @fusion/core exec vitest run --config vitest.pg.config.ts \
  src/__tests__/postgres/dispatch-wake.pg.test.ts --silent=passed-only --reporter=dot

# The real HTTP entry point actually publishes a wake.
pnpm --filter @fusion/dashboard exec vitest run \
  src/routes/__tests__/register-task-workflow-routes.dispatch-wake.test.ts \
  app/components/__tests__/TaskCard.dispatch-wake.test.tsx --silent=passed-only --reporter=dot
```

## How to read the diagnostic

`task:dispatch-latency-observed` (see `docs/run-audit.md`) attributes a remaining wait. Two rows are
worth looking for first:

- `wakeOrigin: "periodic-backstop"` means the EVENT path did not deliver for that pass — a lost
  notification, a reconnection window, or a degraded transport.
- `reasonCode: "transport-degraded"` names a cross-process transport that could not start (no proven
  direct session target, or `LISTEN` failed). The engine is still correct in that state — durable
  rows and periodic recovery remain authoritative — but wakes from other processes will not arrive.
