import { columnsWithFlag, declaresAnyLifecycleTrait, resolveWorkflowIrForTask, type WorkflowIr } from "@fusion/core";

/*
FNXC:WorkflowResolvedColumns 2026-07-30-08:45 (#2783 review — coderabbit):
The store parameter is the shape `resolveWorkflowIrForTask` ACTUALLY needs, not `Pick<TaskStore, "getTask">`.

The first version took `getTask` — which none of these helpers call — and cast it through `unknown` to
reach the resolver. That cast was a type lie in the load-bearing direction: it let a caller pass a
partial store with no workflow readers, where every call would throw into the catch and silently
return the legacy answer forever. Typed properly, a store that cannot resolve workflows is a compile
error at the call site instead of a silent permanent fallback at runtime.
*/
type LaneResolverStore = Parameters<typeof resolveWorkflowIrForTask>[0];

/*
FNXC:WorkflowResolvedColumns 2026-07-30-03:10 (batch-core):

ONE ANSWER TO "HAS THIS TASK LANDED?", SHARED BY EVERY DASHBOARD SURFACE THAT ASKS IT.

Several places asked it independently and all compared against the literal `done`, so on a renamed
board they silently stopped firing — source issues were never commented on or closed, and finished
tasks diffed against a branch that had already been merged.

Both helpers resolve the workflow's complete columns. `landedColumnsForTask` names diff-boundary
callers while `completeColumnsForTask` names completion-trigger callers, keeping their intent explicit.

EMPTY MEANS UNEXPRESSED, NOT ABSENT. `synthesizeDefaultColumns` (workflow-ir.ts:158-159) upgrades a v1
graph by emitting every default column with `traits: []`, so a v1-upgraded workflow resolves to an
EMPTY set while its `done` column plainly exists and holds finished cards. Reading empty as "this
board has no complete lane" would stop these surfaces firing on every pre-v2 project — a worse
regression than the one being fixed, and invisible to any v2 fixture. Empty therefore takes the same
legacy fallback as a workflow that cannot be read at all.
*/
const LEGACY_LANDED_COLUMNS: readonly string[] = ["done"];

export async function landedColumnsForTask(
  store: LaneResolverStore,
  taskId: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<Set<string>> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId, irCache);
    if (!declaresAnyLifecycleTrait(ir)) return new Set(LEGACY_LANDED_COLUMNS);
    return new Set(columnsWithFlag(ir, "complete"));
  } catch {
    return new Set(LEGACY_LANDED_COLUMNS);
  }
}


/*
FNXC:WorkflowResolvedColumns 2026-07-30-03:25 (batch-core):
COMPLETE ONLY — callers use this name when completion itself is the trigger.
*/
export async function completeColumnsForTask(
  store: LaneResolverStore,
  taskId: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<Set<string>> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId, irCache);
    const complete = columnsWithFlag(ir, "complete");
    return new Set(complete.length > 0 ? complete : ["done"]);
  } catch {
    return new Set(["done"]);
  }
}


/*
FNXC:WorkflowResolvedColumns 2026-07-30-05:05 (batch-core):
WIP lanes — "is this card actively being worked?". Uses `countsTowardWip`, which is the trait the
concurrency limit is keyed on, so this answers the same question the scheduler does rather than a
parallel one.
*/
export async function wipColumnsForTask(
  store: LaneResolverStore,
  taskId: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<Set<string>> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId, irCache);
    if (!declaresAnyLifecycleTrait(ir)) return new Set(["in-progress"]);
    return new Set(columnsWithFlag(ir, "countsTowardWip"));
  } catch {
    return new Set(["in-progress"]);
  }
}

/*
FNXC:WorkflowResolvedColumns 2026-07-30-06:50 (batch-core):
PRE-WIP lanes — intake and hold together, the columns a card sits in before work starts. Kept as one
helper because every caller so far asks "is this queued", not "is it specifically intake": splitting
them would push that distinction onto callers that do not have it.
*/
export async function preWipColumnsForTask(
  store: LaneResolverStore,
  taskId: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<Set<string>> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId, irCache);
    if (!declaresAnyLifecycleTrait(ir)) return new Set(["todo"]);
    return new Set([...columnsWithFlag(ir, "intake"), ...columnsWithFlag(ir, "hold")]);
  } catch {
    return new Set(["todo"]);
  }
}
