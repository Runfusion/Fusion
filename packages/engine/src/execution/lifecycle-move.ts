import {
  ENGINE_BACKWARD_MOVE_REASONS,
  TransitionRejectionError,
  resolveContainedBackwardTargetForTask,
  type MoveTaskOptions,
  type TaskStore,
} from "@fusion/core";
import { diagnosticSignature, logDiagnosticOnce } from "../util/durable-diagnostic-log.js";

export type LifecycleMoveResult =
  | { moved: true }
  | { moved: false; deferred: "capacity"; detail: string };

export type ContainedLifecycleMoveResult = LifecycleMoveResult
  | { moved: false; reason: "no-contained-target" | "in-place-recovery"; column: string };

/*
FNXC:LifecycleContainment 2026-10-07-15:22 (RUFU-308 Step 3):
The two refusal lines below are SIGHTING records — they state that a recovery pass asked this seam for
something it must refuse — not state records. RUFU-291 proved an unbounded sighting log is how a dead
card masquerades as "being worked on": `self-healing-stranded-recovery` asked for a backward move every
~45 s, the card never moved, and the History surface filled with byte-identical lines while nothing
owned re-entry. A refusal is therefore recorded once per (taskId, refusal kind, column, live-state
signature): an identical repeat returns silently, and only a state change (lane, status, step rows)
re-announces. The FIRST sighting of a signature stays unconditional — existing recovery tests assert the
durable line, and the operator must always see a refusal they have not yet seen.

The dedupe state is keyed by the store instance (WeakMap) rather than by a process-global map because
engine processes, and every test in a file, share one module instance: a global map would let one
card's signature suppress a different store's identical card, which is exactly the false silence an
operator cannot debug. Execution re-entry is owned by `executor/execution-rearm.ts` (same node, same
step, no lane change); this seam keeps only the refusal.
*/
let containmentLogSignatures = new WeakMap<object, Map<string, string>>();

/**
 * Structural, timestamp-free live-state fingerprint: what an operator would call "the card's state".
 *
 * FNXC:LifecycleContainment 2026-10-07-17:05 (RUFU-308 Step 5):
 * Exported because the graph-failure refusal in `executor/route-graph-failure-to-execution-resume.ts`
 * is the second sighting-record writer: RUFU-291's evidence-less disposal cycle re-logged its own
 * refusal line on every ~45 s pass, and a refusal line the operator has already seen is the noise this
 * bound exists to remove. Both writers therefore suppress on the SAME fingerprint, so one card cannot
 * be silent for one refusal and chatty for the other.
 */
export function containmentLiveSignature(task: {
  column: string;
  status?: string | null;
  paused?: boolean;
  userPaused?: boolean;
  steps?: Array<{ status: string }>;
  workflowStepResults?: Array<{ workflowStepId: string; status: string }>;
}): string {
  const steps = (task.steps ?? []).map((step, index) => `${index}:${step.status}`).join(",");
  const results = [...(task.workflowStepResults ?? [])]
    .sort((left, right) => left.workflowStepId.localeCompare(right.workflowStepId))
    .map((result) => `${result.workflowStepId}:${result.status}`)
    .join(",");
  // `error` is deliberately excluded: parked error sentences carry counters and timestamps, so
  // including them would re-announce on every poll and defeat the bound this helper exists to give.
  return [task.column, task.status ?? "null", task.paused === true ? "paused" : "running",
    task.userPaused === true ? "user-paused" : "", steps, results].join("|");
}

/** True on the first sighting of a refusal signature; identical repeats are silent. */
export function shouldLogContainmentRefusal(
  store: object,
  taskId: string,
  kind: string,
  signature: string,
): boolean {
  let seen = containmentLogSignatures.get(store);
  if (!seen) {
    seen = new Map<string, string>();
    containmentLogSignatures.set(store, seen);
  }
  const key = `${taskId}\u0000${kind}`;
  if (seen.get(key) === signature) return false;
  seen.set(key, signature);
  return true;
}

/** Test-only: clears every store's sighting memory so a suite cannot leak silence between cases. */
export function resetContainmentRefusalLogForTesting(): void {
  containmentLogSignatures = new WeakMap();
}

/*
FNXC:LifecycleContainment 2026-08-28-03:03:
FN-207 centralizes source-relative backward recovery: review may target only WIP, WIP may target only
hold, no target means no move, and capacity refusal remains in place. The seam preserves the caller's
raw source because assigning engine here would change guard-bypass behavior for optionless callers.
*/
export async function moveTaskToContainedBackwardTarget(
  store: TaskStore,
  taskId: string,
  reason: string,
  options?: MoveTaskOptions,
  _liveColumn?: string,
): Promise<ContainedLifecycleMoveResult> {
  /*
  FNXC:LifecycleContainment 2026-09-22-14:05:
  Recovery callers can hold a task snapshot across git and filesystem awaits. Re-read the durable
  column before choosing a backward target so an operator move during recovery wins over stale
  caller metadata; `liveColumn` remains a diagnostic hint for compatibility, not mutation authority.
  */
  const live = await store.getTask(taskId);
  const column = live.column;
  const revisionReasons = new Set([
    "plan-review-revise-replan",
    "code-review-revise-remediation",
    "verification-failure-remediation",
    "merge-fix-remediation",
  ]);
  if (!revisionReasons.has(reason)) {
    /*
    FNXC:LifecycleContainment 2026-10-07-15:22 (RUFU-308 Step 3):
    A `self-healing-stranded-recovery` refusal on an executor-stage card is the RUFU-291 loop's own
    footprint: the recovery wanted the SAME node and step, which is execution re-arm's to grant, not a
    lane change. So the refusal stays log-only HERE (this seam has no re-entry authority) and the caller
    routes the card into `attemptExecutionRearm`; the line is written once per state signature so a
    card nobody owns can no longer look busy forever.

    FNXC:DiagnosticLogDedupe 2026-10-11-22:51 (RUFU-643):
    That bound was in-process, and this refusal line still measured 16,025 rows on the live board: the
    WeakMap dies with the process, and the supervised dashboard restarts every ~14-27 min (RUFU-642), so
    each restart re-announced every card's refusal. The in-process gate stays — it is what keeps a
    45-second recovery cadence from touching the database at all — and the append it grants is now also
    keyed durably on the same state signature, so "first sighting" means first sighting since six hours
    ago, across processes.
    */
    const retainedSignature = containmentLiveSignature(live);
    if (shouldLogContainmentRefusal(store, taskId, `retained:${reason}`, retainedSignature)) {
      await logDiagnosticOnce(store, taskId, {
        action: `Lifecycle recovery retained in '${column}' — ${reason} has no backward-move authority`,
        dedupeKey: `lifecycle-containment:retained:${reason}:${diagnosticSignature(retainedSignature)}`,
      });
    }
    return { moved: false, reason: "in-place-recovery", column };
  }
  const target = await resolveContainedBackwardTargetForTask(store, taskId, column);
  if (!target) {
    const containedSignature = containmentLiveSignature(live);
    if (shouldLogContainmentRefusal(store, taskId, "no-contained-target", containedSignature)) {
      await logDiagnosticOnce(store, taskId, {
        action: `Lifecycle rebound contained in '${column}' — the workflow declares no adjacent backward destination`,
        dedupeKey: `lifecycle-containment:no-contained-target:${diagnosticSignature(containedSignature)}`,
      });
    }
    return { moved: false, reason: "no-contained-target", column };
  }
  return moveTaskWithLifecycleReason(store, taskId, target, reason, options);
}

export async function moveTaskWithLifecycleReason(
  store: TaskStore,
  taskId: string,
  toColumn: string,
  reason: string,
  options?: MoveTaskOptions,
): Promise<LifecycleMoveResult> {
  try {
    await store.moveTask(taskId, toColumn, { ...options, lifecycleReason: reason });
    return { moved: true };
  } catch (error) {
    if (!(error instanceof TransitionRejectionError) || error.rejection.code !== "capacity-exhausted") {
      throw error;
    }
    const task = await store.getTask(taskId);
    const summary = ENGINE_BACKWARD_MOVE_REASONS[reason]?.summary ?? reason;
    await store.logEntry(
      taskId,
      `Lifecycle move deferred: ${task.column} → ${toColumn} (backward) — ${summary} (destination at capacity; retrying later)`,
    ).catch(() => undefined);
    return { moved: false, deferred: "capacity", detail: error.rejection.detail ?? "destination at capacity" };
  }
}
