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

WHICH HELPER EACH CALLER TAKES IS NOT UNIFORM, and the split is deliberate:
  - `landedColumnsForTask` (complete u archived) — the session-diff boundary, where an archived task
    has equally landed and its diff must come from the merge commit.
  - `completeColumnsForTask` (complete only) — the GitHub and GitLab source-issue commenters, the
    GitLab backfill reconciler, and the knowledge refresh. Their originals fired on `done` alone;
    widening them to archival would post comments and close issues the literal never touched. #2783's
    review caught exactly that regression in my first pass.

Five copies of one question is how the halves drift apart (FN-6115 -> FN-6118 -> FN-6123 is the
motivating incident: the same affordance fixed three times because it lived in two components). So
this is the single home, and the callers do nothing but ask it.

MEMBERSHIP over `complete` and `archived`. Both mean landed for these purposes — an archived task is
not un-finished — and a board may declare more than one column carrying either role, so
`columnsWithFlag(...)[0]` would silently ignore the second.

EMPTY MEANS UNEXPRESSED, NOT ABSENT. `synthesizeDefaultColumns` (workflow-ir.ts:158-159) upgrades a v1
graph by emitting every default column with `traits: []`, so a v1-upgraded workflow resolves to an
EMPTY set while its `done` column plainly exists and holds finished cards. Reading empty as "this
board has no complete lane" would stop these surfaces firing on every pre-v2 project — a worse
regression than the one being fixed, and invisible to any v2 fixture. Empty therefore takes the same
legacy fallback as a workflow that cannot be read at all.
*/
const LEGACY_LANDED_COLUMNS: readonly string[] = ["done", "archived"];

export async function landedColumnsForTask(
  store: LaneResolverStore,
  taskId: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<Set<string>> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId, irCache);
    const landed = [...columnsWithFlag(ir, "complete"), ...columnsWithFlag(ir, "archived")];
    return new Set(landed.length > 0 ? landed : LEGACY_LANDED_COLUMNS);
  } catch {
    return new Set(LEGACY_LANDED_COLUMNS);
  }
}


/*
FNXC:WorkflowResolvedColumns 2026-07-30-03:25 (batch-core):
COMPLETE ONLY — deliberately narrower than `landedColumnsForTask`, for callers whose contract
excludes archived work rather than merely never encountering it.

The GitLab backfill reconciler is the case: its own FNXC note records that archived tasks live in
`archiveDb` and that the active-task backfill intentionally excludes them, so it must not widen to
the archived role just because the shared helper offers it. Today it lists with
`includeArchived: false` and would see no archived rows either way — but that is an incidental
property of the query, not the contract, and folding the two together would quietly couple them.
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
FNXC:WorkflowResolvedColumns 2026-07-30-04:05 (batch-core):
ARCHIVED ONLY. Separate from `completeColumnsForTask` because archival is a distinct lifecycle event
with its own consumers: retention cutoffs and live-board eligibility ask "is this card OFF the board",
which a complete-but-not-archived card is not.

The two roles resolve independently and have failed independently before, so they get independent
helpers rather than one flag argument — a caller that wants both asks `landedColumnsForTask`.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:55 (batch-core, following #2821's review):
THE EMPTY SET AND THE UNEXPRESSED ONE ARE DIFFERENT, and these three conflated them.

Each read `resolved.length > 0 ? resolved : legacyId`, which is right for a v1 upgrade — every column
emitted with `traits: []`, so the legacy id is the only vocabulary that exists — and wrong for a v2
board that expresses traits and simply declares no lane of that role. There the legacy id is a column
the board may still HAVE without meaning it: a `done` or `archived` column left untraited on purpose.
Falling back onto it widens the guard onto a role the board explicitly did not assign.

`declaresAnyLifecycleTrait` separates the two, matching the shape #2821's review established for
`resolveNodeOverrideLanes`. A board that traits nothing keeps the legacy id; a board that traits
something is taken at its word, including when the answer is "no such lane".
*/
export async function archivedColumnsForTask(
  store: LaneResolverStore,
  taskId: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<Set<string>> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId, irCache);
    if (!declaresAnyLifecycleTrait(ir)) return new Set(["archived"]);
    return new Set(columnsWithFlag(ir, "archived"));
  } catch {
    return new Set(["archived"]);
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
