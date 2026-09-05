---
category: architecture-patterns
module: packages/engine/src/scheduler.ts
date: 2026-08-12
problem_type: performance
severity: high
applies_when:
  - "Looping a per-task store read inside a scheduler/engine pass that visits the same task multiple times"
  - "Seeing Drizzle buildQueryFromSourceParams dominate a CPU profile (~70%) or runaway pg_stat idx_scan counts on a selection/config table"
  - "Adding any caller-owned per-pass cache to a hot engine loop"
component: scheduler
tags:
  - performance
  - query-storm
  - workflow-selection
  - drizzle
  - per-pass-cache
  - fnxc-workflowscheduling
related_components:
  - development_workflow
  - scheduler
  - workflow_resolution
---

# Workflow selection read-once-per-tick in the scheduler (the RUFU-073 query storm)

## Symptom

Production CPU sat at 62–70% and the health API took 0.77–2.0s. A `cpuprofile` showed **70.6% of the
node event loop inside Drizzle's `buildQueryFromSourceParams`** (the SQL-string compiler) — the engine
was *building* identical SQL statements nonstop, not waiting on the database. `pg_stat_user_tables`
confirmed the loop was a **cache-miss loop on reads**:

- `project.task_workflow_selection.idx_scan` grew ~232 q/s nonstop (121M cumulative index-scans, only
  281 inserts).
- `project.config` `workflow_prompt_overrides` ~108 q/s (127M scans, 0 inserts).

The DB was not the bottleneck (PG did 5 selects in 46ms, no locks, ~15 connections) — the node process
was flooded by per-read Drizzle SQL-string construction.

## Root cause

`resolveTaskParkedColumns(store, taskId)` resolved the task's workflow IR via
`resolveWorkflowIrForTask(store, taskId)` **without a selection cache**. That is a separate
PostgreSQL select of `task_workflow_selection` (plus a Drizzle SQL build) per *call*. In a single
scheduler event the SAME task is parked-resolved up to ~6×:

`task:moved` merge reconciliation, `task:updated` unpause wake, planning-finished wake, approval-cleared
wake, `task:deleted` dependency reconciliation, and the agent-link rollback path. With 22 active
projects that composed to ~340 q/s of Drizzle SQL building.

## The fix: a caller-owned per-tick selection cache

`resolveWorkflowIrForTask(store, taskId, irCache?, selectionCache?)` and its
`resolveWorkflowIrForTaskWithProvenance(..., selectionCache?)` already accept a
`WorkflowSelectionCache = Map<taskId, WorkflowSelection | undefined>`. The scheduler now creates a
**fresh** selection cache at the top of each event/loop scope and threads it through every
`resolveTaskParkedColumns(store, taskId, selectionCache?)` call. Note the argument positions differ:
the selection cache is the **3rd argument** of `resolveTaskParkedColumns`, whereas it is the
**4th argument** (after the optional `irCache`) of `resolveWorkflowIrForTask(store, taskId,
irCache?, selectionCache?)`. It is also threaded through the `emitHighOverlapFanoutWarnings` escalation
sweep and the PR-hydration sweep:

- Each task's selection is read **at most once per tick** (not once per park-resolution).
- The cache is **strictly per-call/per-pass**: a fresh Map per event/sweep, discarded at scope end.
- A selection WRITE by a later pass is always observed, because the next pass creates a fresh Map.

### In-flight read coalescing (race the first cut hit)

The first iteration put the coalescer only in the sync fallback, and concurrent wake closures sharing
one cache could each see the cache still-empty (the `.has` check runs before the first `await`
resolves) and all hit the DB. The fix tracks an in-flight promise per caller-owned cache object in a
`WeakMap<WorkflowSelectionCache, Map<taskId, Promise>>`: only the first closure performs the read;
later concurrent closures `await` the same promise. The weak key binds it to that pass, so it is NOT a
global/infinite cache and auto-releases when the pass cache is GC'd.

## Invariant (FNXC:WorkflowScheduling)

Selection caches are **per-call/per-scheduler-pass only** and are **strictly invalidated next poll** —
never a global/infinite LRU. A throwing read is deliberately **not** cached so transient PostgreSQL
failures are retried next pass; therefore **instrumentation must count reads, not infer them from
cache-key presence**.

## Verification contract

- A regression test drives one scheduler tick that clears unpause + planning + approval wakes for the
  same task and asserts the selection is read exactly once (not 3×), that N distinct tasks read ≤ N
  selections, that an empty task set reads zero, and that a **second** tick re-reads (proving the
  cache is pass-scoped, so a selection write between ticks is observed).
- The existing resolver contract tests (`workflow-ir-selection-cache`, `workflow-ir-resolution-provenance`)
  pin the per-call caching semantics; the sync-only store path dedups the same way.
- Production verification: `task_workflow_selection` idx_scan growth rate must drop from ~232 q/s to
  below ~30 q/s, health API < 0.5s, CPU < 40%.

## Read-path hydration: prefetch, never resolve per row (FN-9261)

The same resolver is used by task-store hydration. `listTasks`, `searchTasks`, and
`listTasksModifiedSince` used to resolve every row independently, turning one board read into one
selection query per card (and two or three per card for incremental hydration). On an idle board of
about 107 live tasks, hold-release prefetch alone took 1.7–3.2 seconds and regularly exceeded its
10-second budget.

Use `prefetchWorkflowSelections(store, taskIds, cache)` at the start of every multi-row hydration
pass. It deduplicates ids, reads missing selections once through the batch reader, and writes every
requested id to the pass cache. Missing persisted selections are deliberately stored as `undefined`:
cache membership then prevents a second query while the normal resolver still selects
`builtin:coding`. A failed or unavailable batch reader leaves missing keys untouched so existing
individual resolution remains the safe fallback.

`listTasks` additionally accepts optional caller-owned `selectionCache` and mutable
`selectionReadTally` options. The tally reports actual `{ batched, singles }` work performed by the
store; consumers such as hold-release must fold it into diagnostics rather than infer reads from
cache size. Both a successful batch and a degraded sequence of individual reads populate identical
cache entries, so size growth cannot truthfully distinguish them.

**Rule:** every new multi-row task hydration pass prefetches selections once before per-row workflow
resolution. Single-row `getTask` remains deliberately unbatched because it has no N+1.