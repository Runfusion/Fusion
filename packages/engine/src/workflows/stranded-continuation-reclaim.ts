import { ACTIVE_WORKFLOW_WORK_ITEM_STATES, type WorkflowWorkItem } from "@fusion/core";

/*
FNXC:StrandedContinuationReclaim 2026-08-11-09:12:
The scheduler's due-poll (`in-process-runtime.ts` -> `drainDuePlanningContinuations`) selects ONLY
`runnable`/`retrying`. A continuation that stops in `running` or `held` is therefore never looked at
again by any dispatcher, and the two ways it can stop there are both ordinary:

  1. `running` with a dead session. `acquireWorkflowWorkItemLease` is the only historical writer that
     sets `leaseExpiresAt`; the upsert/transition paths that install a fence leave it NULL. Triage's
     `writePlanningContinuation` is one such path, so a LIVE planner used to look exactly like a dead
     owner unless the caller supplied the independent planning-liveness proof.
  2. `held` with a blocked reason nothing retries. `acquireWorkflowWorkItemLease` can only re-take a
     `held` row whose `blockedReason` matches `workflow-principal-%`, `workflow-named-principal-%`, or
     `workflow-role-pool-%`; a NULL or non-matching reason never becomes claimable again.

Observed on the Fusion board on 2026-08-11: seven cards (FN-8932/8950/8953/8954/8956/8957/8958) sat in
`running` behind leases from a process that exited ~9h earlier, and FN-8901/FN-8902 sat `held` with a
NULL `blockedReason` for 46h. None produced a single run-audit row while stranded — the same silent
shape as the FN-8923 incident, whose sweep only covers `held` + `workflowRole: "triage"` +
`blockedReason` starting `workflow-principal-`, and so caught none of these nine.

A third case is pure residue: 33 rows in active states belonged to tasks that were archived AND
soft-deleted, the oldest from 2026-07-13. The FK is `ON DELETE CASCADE`, which only fires on a HARD
delete, so soft-deleting a task strands its continuations forever. They cannot run (their task is gone
from every scan) but they are counted by every `ACTIVE_WORKFLOW_WORK_ITEM_STATES` filter in the engine.

This module is the pure decision shared by the sweep and its tests, so "what is reclaimable" cannot
drift from "what the sweep reclaims" — the drift that let the FN-8923 sweep ship covering one ninth of
the problem it was written for.
*/

/** Terminal disposition for a row whose task can never run it again. */
export const RECLAIM_RETIRED_STATE = "cancelled" as const;

export type StrandedContinuationAction = "requeue" | "retire" | "none";

export type StrandedContinuationReason =
  | "engine-paused"
  | "task-terminal"
  | "task-missing"
  | "operator-paused"
  | "manual-hold"
  | "live-session"
  | "live-planning"
  | "too-fresh"
  | "lease-active"
  | "scheduler-owned"
  | "dead-lease"
  | "unclaimable-hold";

export interface StrandedContinuationVerdict {
  action: StrandedContinuationAction;
  reason: StrandedContinuationReason;
}

/**
 * FNXC:StrandedContinuationReclaim 2026-08-11-09:12:
 * Decide what to do with ONE continuation row. Ordering is deliberate and load-bearing:
 *
 * - `enginePaused` wins over everything. A paused engine must not silently re-queue work an operator
 *   stopped; the row is still stranded when the engine resumes and the next sweep sees it.
 * - Retirement is tested BEFORE the pause and liveness gates. A soft-deleted or historical task has no
 *   operator decision left to respect and no session that could be live, and its row is exactly the
 *   residue that accumulates for a month when this check sits behind those guards.
 * - `manual-hold` is an operator-owned kind (`WORKFLOW_WORK_ITEM_KINDS`), not an accident. Its whole
 *   purpose is to stop until a human acts, so automatic reclaim must never touch it.
 * - Execution and planning liveness are separate caller proofs. Triage is a fourth possible owner of
 *   a `running` row, and its historical `writePlanningContinuation` path left `leaseExpiresAt` NULL.
 *   Both live-owner guards therefore outrank dead-lease classification and prevent double dispatch.
 * - `lease-active` still defers to a real unexpired lease even past the grace window: an expiry in the
 *   future is affirmative proof of a live claim, which staleness alone never is.
 *
 * @param input.item The continuation row under consideration.
 * @param input.taskTerminal The owning task is deleted, archived, or otherwise past running this row.
 * @param input.taskMissing No task row resolved for `item.taskId` at all.
 * @param input.live Caller-proven live execution for the owning task.
 * @param input.planningLive Caller-proven live planning for the owning task; omitted means false.
 * @param input.stalenessMs Age of the row's last update.
 * @param input.graceMs Minimum age before a row is considered abandoned.
 */
export function evaluateStrandedContinuationReclaim(input: {
  item: Pick<WorkflowWorkItem, "state" | "kind" | "leaseExpiresAt" | "blockedReason">;
  taskTerminal: boolean;
  taskMissing: boolean;
  taskPaused: boolean;
  live: boolean;
  planningLive?: boolean;
  enginePaused: boolean;
  stalenessMs: number;
  graceMs: number;
  now: number;
}): StrandedContinuationVerdict {
  if (input.enginePaused) return { action: "none", reason: "engine-paused" };
  if (input.taskMissing) return { action: "retire", reason: "task-missing" };
  if (input.taskTerminal) return { action: "retire", reason: "task-terminal" };
  if (!ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(input.item.state)) {
    return { action: "none", reason: "scheduler-owned" };
  }
  if (input.item.kind === "manual-hold") return { action: "none", reason: "manual-hold" };
  if (input.taskPaused) return { action: "none", reason: "operator-paused" };
  if (input.live) return { action: "none", reason: "live-session" };
  /*
  FNXC:PlanningExecutionLiveness 2026-09-06-00:29:
  A triage planner can own this row without any execution-liveness signal. Keep that proof distinct so
  recovery diagnostics identify `live-planning`, while omission preserves legacy callers as not live.
  */
  if (input.planningLive === true) return { action: "none", reason: "live-planning" };
  /*
  FNXC:StrandedContinuationReclaim 2026-08-11-09:12:
  `runnable`/`retrying` rows are the dispatcher's own queue. They are only reachable here through the
  retirement branches above (a dead task's row), never for reclaim — re-writing a live queue entry
  would reset its scheduling position for no gain.
  */
  if (input.item.state === "runnable" || input.item.state === "retrying") {
    return { action: "none", reason: "scheduler-owned" };
  }
  if (input.stalenessMs < input.graceMs) return { action: "none", reason: "too-fresh" };
  if (input.item.state === "running") {
    const expiresAt = input.item.leaseExpiresAt ? Date.parse(input.item.leaseExpiresAt) : Number.NaN;
    if (Number.isFinite(expiresAt) && expiresAt > input.now) return { action: "none", reason: "lease-active" };
    return { action: "requeue", reason: "dead-lease" };
  }
  return { action: "requeue", reason: "unclaimable-hold" };
}
