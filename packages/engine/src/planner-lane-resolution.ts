/*
FNXC:WorkflowLifecycleColumns 2026-07-30-12:40 (U11 — PR #2610 review):
Resolves a task's planner vocabulary for the two guards that consume it, so the
seams in `mission-feature-sync` and `spec-staleness` are actually DRIVEN rather
than defaulted. Both bots flagged the unwired seam; they were right.

TWO SHAPES, because the guards ask different questions:

  plannerLanes — intake AND hold. "Is this card waiting to be planned?", true in
  either lane.

  dedicatedPlannerColumn — the intake lane ONLY WHEN it is not also the hold lane.
  On a merged lineage the planner distinction is carried by STATUS
  (`planning`/`needs-replan`), not by the column, so a merged workflow correctly
  yields NOTHING here. Returning the merged column instead would stop a parked card
  with preserved progress from skipping staleness — the regression the pre-existing
  U11 proof in `spec-staleness.test.ts` describes as "same column, different
  status, opposite correct answer".

FAIL-SOFT, with a caveat worth stating because I got it wrong first: an unreadable
selection does NOT yield `undefined`. `resolveWorkflowIrForTask` falls back to the
DEFAULT workflow IR, so resolution never reports ignorance — the same property that
makes `resolveTaskWorkflowIrSync` return the default rather than a selection. Post
-#2515 that default is MERGED, so the dedicated resolver then yields an empty list.
That is correct: `triage` is not declared by that lineage, so a card sitting there
is stranded rather than in a planner lane, and rescuing it belongs to the
undeclared-column sweep, not to these guards. `undefined` is reserved for the case
where even the default cannot be resolved.
*/
import { resolveTaskLifecycleColumns, type TaskStore, type WorkflowIr } from "@fusion/core";

export async function resolvePlannerLanesForTask(
  store: TaskStore,
  taskId: string,
  cache?: Map<string, WorkflowIr>,
): Promise<readonly string[] | undefined> {
  const roles = await resolveTaskLifecycleColumns(store, taskId, cache).catch(() => undefined);
  if (!roles) return undefined;
  const lanes = [roles.intake, roles.hold].filter((c): c is string => typeof c === "string");
  return lanes.length > 0 ? [...new Set(lanes)] : undefined;
}

export async function resolveDedicatedPlannerColumnsForTask(
  store: TaskStore,
  taskId: string,
  cache?: Map<string, WorkflowIr>,
): Promise<readonly string[] | undefined> {
  const roles = await resolveTaskLifecycleColumns(store, taskId, cache).catch(() => undefined);
  if (!roles?.intake) return undefined;
  /* Merged intake+hold: no DEDICATED planner column exists, and saying so is the
     correct answer, not a failure to resolve one. */
  return roles.intake === roles.hold ? [] : [roles.intake];
}
