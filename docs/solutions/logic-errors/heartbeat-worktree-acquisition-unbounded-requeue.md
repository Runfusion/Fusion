---
title: "Durable-agent heartbeat worktree acquisition retried unboundedly and failures went uncounted"
date: 2026-07-09
category: docs/solutions/logic-errors
module: "engine agent heartbeat + worktree acquisition"
problem_type: logic_error
component: engine
symptoms:
  - "A worktree-setup loop repeats an identical git worktree add -b <branch> failure across many hours"
  - "The same branch collision is retried against several different generated worktree directories"
  - "performanceSummary.totalTasksFailed / CentralCore failure stats stay 0 despite a real, eventually-terminal task failure"
root_cause: invariant_gap
resolution_type: code_fix
severity: medium
related_components:
  - "packages/engine/src/agent-heartbeat.ts (HeartbeatMonitor.executeHeartbeat)"
  - "packages/engine/src/runtimes/in-process-runtime.ts (recordTaskCompletion wiring)"
tags:
  - worktrees
  - heartbeat
  - durable-agents
  - retry-cap
  - run-audit
  - requeue-loop
---

# Durable-agent heartbeat worktree acquisition retried unboundedly and failures went uncounted

## Problem

`Executor.createWorktree` (the main task-execution path) has always bounded its
worktree-creation retries via `MAX_WORKTREE_RETRIES = 3` with exponential
backoff, and terminal failures flow through `Executor`'s `onError` callback into
`InProcessRuntime.recordTaskCompletion`, which increments `CentralCore`'s
`totalTasksFailed`.

`HeartbeatMonitor.executeHeartbeat` has a **separate** task-worktree-acquisition
call path used when a durable custom agent's heartbeat picks up its assigned
task (`acquireTaskWorktree`, distinct from `Executor.createWorktree`). Before
this fix, that path had no retry cap at all: on any acquisition failure it
unconditionally moved the task back to `todo` (`preserveProgress: true`) and
completed the heartbeat run successfully. Each subsequent heartbeat interval
was an independent, uncounted retry of the same acquisition — a persistently
failing collision (e.g. a branch genuinely owned by a live foreign task with
sibling-branch-rename disabled) could requeue to `todo` indefinitely across
many hours, and because the task never reached a terminal `status: "failed"`
state, the failure was never recorded via `CentralCore.recordTaskCompletion`.

## Root Cause

Two independent retry/bounding mechanisms exist for worktree creation
(`Executor.createWorktree`'s in-call loop, and the heartbeat's per-cycle call),
but only the executor path was ever wired to a shared retry-cap counter and to
`CentralCore.recordTaskCompletion`. The heartbeat path bypassed both.

## Fix

- `agent-heartbeat.ts`: added `MAX_HEARTBEAT_WORKTREE_ACQUISITION_RETRIES = 3`.
  Reuses `Task.recoveryRetryCount` (no schema migration) as a cross-heartbeat
  counter. Below the cap, bump the counter and requeue as before. At/above the
  cap, mark the task terminally `status: "failed"` (the same convention the
  executor uses — the task stays visible in `todo` for `fn_task_retry`), log a
  clear error citing the branch and attempt count, and invoke a new optional
  `onTaskAcquisitionExhausted(taskId, detail)` callback.
- `runtimes/in-process-runtime.ts`: wires `onTaskAcquisitionExhausted` to
  `this.recordTaskCompletion(taskId, false)`, so the failure is counted the
  same way `Executor`'s `onError` counts one.

## Prevention

When adding a new retry loop around a resource-acquisition call that already
has an established bounded-retry convention elsewhere in the codebase (here:
`Executor.createWorktree`'s `MAX_WORKTREE_RETRIES` + `NonRetryableWorktreeError`
+ `onError` → `recordTaskCompletion`), verify the new call site reuses or
mirrors that convention instead of independently reimplementing a "just
requeue on failure" fallback with no cap and no failure-counting hook.

## Related

- `docs/solutions/logic-errors/repo-root-task-worktree-requeue-loop.md` — a
  different (already-fixed) unbounded-requeue shape in the executor's own
  resume path.
- Regression tests: `packages/engine/src/__tests__/agent-heartbeat-worktree.test.ts`,
  `packages/engine/src/__tests__/in-process-runtime.test.ts`.
