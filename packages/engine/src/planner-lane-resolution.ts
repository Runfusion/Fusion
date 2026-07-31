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
import { resolveLifecycleColumns, resolveTaskLifecycleColumns, resolveWorkflowIrForTask, type TaskStore, type WorkflowIr } from "@fusion/core";

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-04:10 (PR #2616 review — greptile; a real
defect in code I merged in #2610):
A HOLD COLUMN IS ONLY A PLANNER LANE IF IT SITS BEFORE IMPLEMENTATION.

`resolveLifecycleColumns` returns `hold` as the FIRST hold-trait column in declared
order, with no positional constraint relative to wip. A workflow that uses a
hold-trait column for a MID-PIPELINE wait — a pause after implementation has started
— therefore had that column returned as its planner lane, and
`reconcileMissionFeatureState` demoted the feature to `triaged`. The mission board
then reported started work as not-yet-started: silent, and wrong in the direction
that makes a roadmap lie.

The default and Ideas lineages are unaffected because their hold precedes wip, which
is why this survived: every workflow anyone tested has the hold in front.

So the lane test is now POSITIONAL. A hold column counts only when it appears before
the wip column in declared order; a wip column that cannot be located leaves the hold
out rather than guessing, because including it wrongly demotes live work while
excluding it wrongly only costs a `triaged` transition the next reconcile re-applies.
*/
export async function resolvePlannerLanesForTask(
  store: TaskStore,
  taskId: string,
  cache?: Map<string, WorkflowIr>,
): Promise<readonly string[] | undefined> {
  const ir = await resolveWorkflowIrForTask(store, taskId, cache).catch(() => undefined);
  if (!ir) return undefined;
  const roles = resolveLifecycleColumns(ir);
  if (!roles) return undefined;

  const declared = (ir as { columns?: Array<{ id: string }> }).columns ?? [];
  const indexOf = (id: string | undefined): number =>
    id === undefined ? -1 : declared.findIndex((column) => column.id === id);
  const wipIndex = indexOf(roles.wip);
  const holdIndex = indexOf(roles.hold);
  const holdPrecedesWip = holdIndex >= 0 && wipIndex >= 0 && holdIndex < wipIndex;

  const lanes = [roles.intake, holdPrecedesWip ? roles.hold : undefined]
    .filter((c): c is string => typeof c === "string");
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
