/**
 * FNXC:CodeOrganization 2026-08-03-21:05:
 * isBackwardMoveOutOfPlanning peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowResolvedColumns 2026-07-31-23:59 (fallback CHANGED — adopting the better argument
 * from the duplicate PR #3140):
 * The payload is the real path and is preferred. The FALLBACK, for the case where the emitter could
 * not resolve, is the SYNC resolver rather than the legacy literals.
 *
 * I had it the other way round. Falling back to literals reads cleaner and drops these guards off
 * `check-inert-sync-lanes` — but it makes the NO-PAYLOAD path strictly WORSE, because
 * `resolvePlannerLanes` is best-effort (it answers correctly under legacy SQLite, and only degrades
 * to the default board under PostgreSQL) whereas a literal can never be right on a renamed board.
 * Optimising the guard off a ratchet at the cost of the degraded path is scoring the number.
 *
 * THESE TWO GUARDS STAY COUNTED by `check-inert-sync-lanes`, which is the honest state: the sync
 * call is still here, so the ratchet should still point at it. `executor.ts` goes 4 -> 2, from the
 * `isPlannerColumnFor` deletion below, not from these.
 *
 * That took two corrections to get right, recorded because the intermediate state was wrong in a way
 * that looked authoritative. I predicted "stays counted", the gate reported ZERO, and I wrote the
 * under-reporting down as fact. It was a gate defect, not a property of this code: the scan
 * registered a sync local only from a direct call initializer and did not follow one through a
 * conditional (#3169) or through the object literal these lanes are rebuilt into (#3170). With both
 * hops followed the gate reports 2 here — the original prediction.
 *
 * The shape was deliberately NOT rewritten to whatever form the scanner recognised. Payload-first
 * with a sync fallback is correct on the merits, and a guard that pushes authors toward a worse
 * degraded path to keep its own count tidy is a guard doing harm — so the scanner was fixed instead.
 */
import type { TaskStore } from "@fusion/core";
import type { TaskMoveLanes } from "@fusion/core";
import { resolvePlannerLanes } from "../execution/replan-target.js";

export function isBackwardMoveOutOfPlanning(
  store: TaskStore,
  taskId: string,
  from: string,
  to: string,
  moveLanes: TaskMoveLanes | undefined,
): boolean {
  const sync = moveLanes ? undefined : resolvePlannerLanes(store, taskId);
  const lanes = {
    hold: moveLanes?.hold ?? sync?.hold ?? "todo",
    intake: moveLanes?.intake ?? sync?.intake ?? "triage",
    wip: moveLanes?.wip ?? sync?.wip ?? "in-progress",
    review: moveLanes?.review ?? sync?.review ?? "in-review",
    complete: moveLanes?.complete ?? sync?.complete ?? "done",
  };
  if (from !== lanes.hold && from !== lanes.intake) return false;
  const forwardTargets = [lanes.wip, lanes.review, lanes.complete].filter(
    (column): column is string => typeof column === "string",
  );
  /*
  DELIBERATELY NOT ALSO EXCLUDING planner-to-planner moves. The literal version fired the
  evacuation on `todo -> triage` (a replan rebound), and whether that is right is a separate
  question from this review fix — the replan path is engine-initiated, so aborting the planning
  session there may be exactly wrong, but changing it is a behavior change with its own
  surfaces to enumerate. This conversion keeps that case behaving as it does today.
  */
  return !forwardTargets.includes(to);
}
