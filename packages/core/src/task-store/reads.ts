/**
 * reads operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import { shouldWarnPromptParseFailure } from "./task-artifacts-ops.js";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {existsSync, statSync} from "node:fs";
import type {Task, TaskDetail, ColumnId, ArchivedTaskEntry, TaskVerificationRequest, TaskVerificationResultSummary, TaskVerificationStatus, TaskRecommendation, TaskRecommendationListItem, TaskRecommendationListPage, Settings} from "../types.js";
import * as schema from "../postgres/schema/index.js";
import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import "../builtin-traits.js";
import {allowsAutoMergeProcessing} from "../merge/task-merge.js";
import {getInReviewStallReason, DEFAULT_STALE_MERGING_MIN_AGE_MS, type InReviewStallContext} from "../tasks/in-review-stall.js";
import {getAgentLogFilePath} from "../agents/agent-log-file-store.js";
import {getInReviewStalledSignal, type InReviewStalledContext} from "../tasks/in-review-stalled.js";
import {getStalePausedReviewSignal, type StalePausedReviewContext} from "../tasks/stale-paused-review.js";
import {getStalePausedTodoSignal} from "../tasks/stale-paused-todo.js";
import {columnsWithFlag, resolveLifecycleColumns, resolveReviewColumns, type LifecycleColumns} from "../workflows/workflow-lifecycle-traits.js";
import {prefetchWorkflowIrs, prefetchWorkflowSelections, resolveWorkflowIrForTask, type WorkflowDefinitionReadTally, type WorkflowSelectionCache, type WorkflowSelectionReadTally} from "../workflows/workflow-ir-resolver.js";
import type {WorkflowIr} from "../workflows/workflow-ir-types.js";

import {getTaskAgeStalenessSignal, type TaskAgeStalenessThresholds} from "../tasks/task-age-staleness.js";
import {resolveTaskLifecycleColumns} from "../workflows/workflow-lifecycle-traits.js";
import {detectStalledReview} from "../tasks/stalled-review-detector.js";
/* FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615): defensive read of the `log_recent` envelope for rows read without `log`. */
import { parseTaskLogRecent } from "./task-log-projections.js";
import {computeRetrySummary} from "../tasks/retry-summary.js";
import {resolveRequiredPreMergeStepIds} from "../merge/required-pre-merge-steps.js";
// FNXC:PostMergeGateOperatorWaiver 2026-09-29-15:49 (RUFU-408): the bypass affordance must ask about the post-merge gates too.
import {resolveRequiredPostMergeGateIds} from "../merge/confirmed-merge-reconciliation.js";
import {deriveReviewBypassTarget, isOperatorPausedForOperatorEscapeHatch, resolveReviewBypassLanes, type ReviewBypassTarget} from "../merge/review-bypass-target.js";
import {deriveTaskStallReason, type TaskStallReason, type TaskStallReasonContext} from "../tasks/task-stall-reason.js";
// FNXC:TaskLookup404 2026-07-26-11:20: typed miss signal so API boundaries can
// answer 404 instead of 500 (see TaskNotFoundError in task-store/errors.ts).
import {TaskNotFoundError} from "../task-store/errors.js";
import { ARCHIVED_SENTINEL_LANES, resolveProjectColumnsForRoles } from "../project-lane-vocabulary.js";
import { taskProjectScope } from "../postgres/data-layer.js";
import { taskQueuePageKey, type TaskQueuePageKey } from "./task-queue-order-ops.js";

/** Merge storage tiers while preserving primary-source authority and order. */
function mergePrimaryById<T extends { id: string }>(primary: T[], secondary: T[]): T[] {
  const byId = new Map(primary.map((entry) => [entry.id, entry]));
  for (const entry of secondary) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

/**
 * Latest agent-log activity for a task: newest matching in-memory buffer entry
 * or the on-disk agent-log.jsonl mtime, whichever is fresher. Mirrors main's
 * TaskStore.getLatestAgentLogActivityMs (FNXC:WorkflowLifecycle 2026-07-01-23:27).
 */
function getLatestAgentLogActivityMs(store: TaskStore, taskId: string): number | undefined {
  let latest = Number.NEGATIVE_INFINITY;
  for (let index = store.agentLogBuffer.length - 1; index >= 0; index -= 1) {
    const entry = store.agentLogBuffer[index];
    if (entry?.taskId !== taskId) continue;
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) {
      latest = Math.max(latest, parsed);
      break;
    }
  }

  try {
    const filePath = getAgentLogFilePath(store.taskDir(taskId));
    if (existsSync(filePath)) {
      const fileMtimeMs = statSync(filePath).mtimeMs;
      if (Number.isFinite(fileMtimeMs)) {
        latest = Math.max(latest, fileMtimeMs);
      }
    }
  } catch (error) {
    storeLog.warn("Skipping agent-log freshness check for stalled badge hydration", {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return Number.isFinite(latest) ? latest : undefined;
}

/**
 * FNXC:WorkflowLifecycle 2026-07-05-15:40:
 * True when an in-review task has agent-log writes newer than its own row
 * update and within the stale-merging window — a merge/review agent is
 * actively streaming, so stall badges must be suppressed. Ported from main's
 * TaskStore.hasFreshAgentLogActivitySinceTaskUpdate, which the PostgreSQL
 * cutover's store split predated.
 */
/*
FNXC:WorkflowLifecycleColumns 2026-07-31-01:20 (fleet — the review lane, resolved):
`reviewColumns` is an optional RESOLVED answer; omitted, this is exactly today's behaviour.

Same defect as `detectStalledReview` and the same blast radius: this gate decides whether a streaming
merge/review agent SUPPRESSES the stall badges. Against the literal it answered `false` for every card
on a renamed board, so `executingTaskIds` stayed empty and the board showed "Stalled"/"Merge stalled"
while a merger was visibly making progress — the precise regression the FNXC note below says this
function was restored to prevent.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-31-14:05 (fleet — inline fallback arms):
DELIBERATE-LITERAL — the no-resolution fallbacks for the two lane questions in this file.

Named sets rather than inline `=== "<id>"` arms. Behaviour is identical to the guards as they stand;
the reason is that the census counts an inline comparison whether or not it sits in a fallback branch
— its `traitFallback` hint is advisory and never changes the count. So a correctly-converted guard
with an inline legacy arm stays on the backlog permanently, and the number stops distinguishing real
debt from documented degraded answers. Same shape as `LEGACY_PLANNER_LANES`.
*/
const LEGACY_REVIEW_LANES: ReadonlySet<string> = new Set(["in-review"]);
const LEGACY_ARCHIVE_LANES: ReadonlySet<string> = new Set(["archived"]);

function hasFreshAgentLogActivitySinceTaskUpdate(
  store: TaskStore,
  task: Pick<Task, "id" | "column" | "updatedAt">,
  now: number,
  reviewColumns?: ReadonlySet<string>,
): boolean {
  if (!(reviewColumns ? reviewColumns : LEGACY_REVIEW_LANES).has(task.column)) return false;
  const latestAgentLogMs = getLatestAgentLogActivityMs(store, task.id);
  if (latestAgentLogMs == null) return false;

  const updatedAtMs = Date.parse(task.updatedAt);
  if (Number.isFinite(updatedAtMs) && latestAgentLogMs <= updatedAtMs) {
    return false;
  }

  return Math.max(0, now - latestAgentLogMs) < DEFAULT_STALE_MERGING_MIN_AGE_MS;
}

import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {countLiveTasks, readCompletedTaskPage, readTaskRow, readLiveTaskRows, readTaskRowByProposalClaimId, readTaskRowsBySourceLineage} from "./async/async-persistence.js";
import {buildTsqueryFragment, liveSearchPredicate, searchTasksTsvector, searchTasksLike} from "./async/async-search.js";
import {
  getArchivedTask,
  listArchivedTasks as listArchivedTaskEntries,
  listArchivedTasksByCreatedOrder,
  searchArchivedTasks,
} from "../async-stores/async-archive-db.js";

/*
FNXC:WorkflowLifecycleColumns 2026-07-28-04:00 (PR #2470 review, P1):
Resolve a task's HOLD column for the stalePausedTodo badge. B1 gave
`getStalePausedTodoSignal` a `holdColumn` parameter, but both hydration sites
here omitted it — so the guard still compared against the literal "todo" and the
dashboard badge was silent for a paused card in a renamed hold column.

Fail-soft to "todo": this is read-path badge hydration, so a workflow lookup
failure must degrade to today's behavior, never break a board list. The cache is
caller-owned so a list hydration reads one IR per workflow rather than per card.
*/
async function resolveHoldColumnForTask(
  store: TaskStore,
  taskId: string,
  cache?: Map<string, WorkflowIr>,
  selectionCache?: WorkflowSelectionCache,
): Promise<string> {
  try {
    const lifecycle = resolveLifecycleColumns(await resolveWorkflowIrForTask(store, taskId, cache, selectionCache));
    return lifecycle?.hold ?? "todo";
  } catch {
    return "todo";
  }
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-29-15:20:
The REVIEW half of the same threading `resolveHoldColumnForTask` does for hold.

B1 gave `getStalePausedTodoSignal` a `holdColumn` parameter and PR #2470's review
caught that both hydration sites here omitted it — a correct guard comparing against
the literal, so the badge was silent on a renamed board. That P1 was fixed for hold and
NOT for its sibling role: `getStalePausedReviewSignal` and `getInReviewStalledSignal`
both take `reviewColumn`, and all six call sites in this file left it defaulted to
"in-review". Same defect, same file, one role over.

Fail-soft to "in-review" for the same reason as the hold helper: this is read-path badge
hydration, so a workflow lookup failure must degrade to today's behavior rather than
break a board list. Cache is caller-owned so a list pass reads one IR per workflow.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-30-22:20 (ONE lane answer for all three stall signals):
The three signals decorating a row — `inReviewStall`, `inReviewStalled`, `stalePausedReview` — each
took their own lane input and DISAGREED: two took a singular `reviewColumn`
(`resolveLifecycleColumns().review`, the FIRST column per role) and the third had no seam at all and
used the literal. So one row could be judged in-review by one signal and not by another, and a board
with a separate merge lane beside its human-review lane had a second review column matching none.

`resolveReviewColumns` is the union of the three review roles. The legacy id stays unioned so a board
mid-rename is never skipped, and all ten call sites now read from THIS answer.
*/
async function resolveReviewColumnsForTask(
  store: TaskStore,
  taskId: string,
  cache?: Map<string, WorkflowIr>,
  selectionCache?: WorkflowSelectionCache,
  definitionReadTally?: WorkflowDefinitionReadTally,
): Promise<ReadonlySet<string>> {
  const columns = new Set<string>(["in-review"]);
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId, cache, selectionCache, definitionReadTally);
    if (ir) for (const id of resolveReviewColumns(ir)) columns.add(id);
  } catch { /* degraded: the legacy id above still answers */ }
  return columns;
}

/*
FNXC:VerdictlessFailedGate 2026-09-14-13:32 (RUFU-217, AC4 — blocker-input parity):
Per-row gate resolution for the `inReviewStall` badge, mirroring the stall-reason wrapper above.
Before this, every `getInReviewStallReason` site withheld `requiredPreMergeStepIds` while the merge
door, the queue, and `deriveTaskStallReason` forwarded them — so the badge showed the legacy
results-only blocker while the card's own refusal named the gate, the exact one-row-two-answers
split this file's sibling notes (WorkflowLifecycleColumns 2026-07-30-20:50) treat as worse than
legacy. Fail-soft exactly like the stall wrapper: no gate answer keeps results-only semantics.
The IR struct is already warm per pass — every row pays `resolveReviewColumnsForTask` — so this is
one pure `resolveRequiredPreMergeStepIds` build, not an extra read.
*/
async function resolveStallGateIdsForTask(
  store: TaskStore,
  task: Pick<Task, "id" | "enabledWorkflowSteps" | "executionMode">,
  cache?: Map<string, WorkflowIr>,
  selectionCache?: WorkflowSelectionCache,
): Promise<ReadonlySet<string> | undefined> {
  try {
    const ir = await resolveWorkflowIrForTask(store, task.id, cache, selectionCache);
    return ir ? resolveRequiredPreMergeStepIds(ir, task.enabledWorkflowSteps, task) : undefined;
  } catch {
    /* No gate answer: the stall probe keeps the legacy results-only semantics. */
    return undefined;
  }
}

/*
FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174):
Per-row wiring for the canonical stall/hold reason, shared by ALL FOUR hydration sites so the
same card cannot answer differently on the board, in detail, on the incremental stream, or in
search. The sites already own the inputs the derivation needs (per-pass IR cache, resolved
review lanes, settings, merge-queue set); this wrapper adds only the two things the sites do
not have: the resolved required-gate ids and a dependency-reference resolver.

The resolver is deliberately LOCK-FREE. `store.getTask` takes the target's per-task advisory
lock — reachable from `getTaskImpl`, which already holds THIS task's lock, so a lock-order
inversion between two mutually-referencing cards could deadlock the two reads. The engine's
completion wrapper tolerates that because it runs outside any task lock; a read-path twin does
not. So references resolve through plain indexed reads: `readTaskRow` (live row), then
`getArchivedTask` (cold-storage snapshot, whose `column` is the literal `"archived"`), then
null. Cost contract: rows covered by the caller's own pass answer from `localColumnByTaskId`
with zero reads (a board feed usually carries blockers and blocked cards together); only a
reference outside the pass pays one indexed read; and because `deriveTaskStallReason` invokes
the resolver ONLY from the dependency branch, cards that are suppressed, terminal, or judged
in the review lane never trigger one.

Satisfaction lanes are populated INSIDE the resolver, keyed by the dependency's own id, before
it returns: `getTaskCompletionBlocker` awaits `resolveTask` immediately before each satisfaction
check, so an entry written during resolution is always visible to the check for that id — the
same lazy substitution the engine performs with a prefetch. An unresolvable workflow leaves the
dep un-mapped, which keeps the documented legacy literals.
*/
async function hydrateTaskStallReason(
  store: TaskStore,
  task: Task,
  options: {
    now: number;
    settings: Settings;
    suppressed: boolean;
    reviewColumns: ReadonlySet<string>;
    lifecycle: LifecycleColumns | undefined;
    irCache: Map<string, WorkflowIr>;
    /*
    FNXC:WorkflowScheduling 2026-09-06 (merge origin/main dd808ed2c6):
    Upstream's selection-batch ratchet (`list-tasks-selection-batching.pg.test.ts`) tolerates ZERO
    singular `getTaskWorkflowSelectionAsync` reads per list pass. The RUFU-174 stall derivation and
    the RUFU-179 bypass derivation resolve the task's own IR, so each hydration pass threads its
    prefetched selection cache here — otherwise the local hydrators reintroduce per-row singles and
    the board pays one selection read per card again.
    */
    selectionCache?: WorkflowSelectionCache;
    localColumnByTaskId: ReadonlyMap<string, string>;
  },
): Promise<TaskStallReason | undefined> {
  if (options.suppressed) return undefined;
  const layer = store.asyncLayer!;
  const satisfactionColumnsByTaskId = new Map<string, { terminal: ReadonlySet<string>; review: ReadonlySet<string> }>();
  const resolveSatisfactionLanes = async (depId: string): Promise<void> => {
    try {
      const ir = await resolveWorkflowIrForTask(store, depId, options.irCache, options.selectionCache);
      if (!ir) return;
      const lanes = resolveLifecycleColumns(ir);
      /*
      FNXC:TaskArchivingRemoved 2026-09-06 (merge origin/main dd808ed2c6, FN-295):
      Upstream removed the `archived` lifecycle trait, so satisfaction is judged on the complete lane
      alone — mirroring the engine twin `resolveDependencySatisfactionColumns` (scheduler.ts) which
      after FN-295 maps terminal to `columnsWithFlag(ir, "complete")` only. Cold-storage entries still
      resolve to the literal "archived" column below; they are simply no longer a terminal lane.
      */
      const terminal = new Set([lanes?.complete].filter((c): c is string => Boolean(c)));
      const review = new Set(resolveReviewColumns(ir));
      // Engine-side twin skips an IR offering neither role, so the dep keeps the legacy literals.
      if (terminal.size === 0 && review.size === 0) return;
      satisfactionColumnsByTaskId.set(depId, { terminal, review });
    } catch {
      /* Unresolvable dependency workflow: omission is the legacy-literal path, not an error. */
    }
  };
  const resolveDependency = async (depId: string): Promise<Pick<Task, "id" | "column"> | null> => {
    const local = options.localColumnByTaskId.get(depId);
    if (local !== undefined) {
      await resolveSatisfactionLanes(depId);
      return { id: depId, column: local };
    }
    try {
      const row = await readTaskRow(layer, depId);
      if (row) {
        await resolveSatisfactionLanes(depId);
        return { id: depId, column: String(row.column) };
      }
      const entry = await getArchivedTask(layer.db, depId, layer.projectId);
      if (entry) return { id: depId, column: entry.column };
      return null;
    } catch (err) {
      storeLog.warn(`[task-stall] dependency reference ${depId} unresolvable for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  let requiredPreMergeStepIds: ReadonlySet<string> | undefined;
  /*
  FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
  The planning lane is the union of the `intake` and `hold` trait columns. FN-302 merged intake into
  the hold column, so a card can stand in a column that answers BOTH, and a merged column can answer
  neither while its sibling does — hence the union rather than one flag. It is resolved from the SAME
  already-cached IR as the required-gate ids above, so naming a planning stall costs no additional
  workflow read, and the list pass still performs zero singular selection reads per row.

  An unresolvable IR leaves this `undefined`, and the derivation stays silent: `todo`/`triage` literals
  are deliberately NOT a fallback here, because stamping "planning is waiting" on a card whose workflow
  has no resolvable planning lane is the lie the fail-open contract forbids.
  */
  let planningColumns: ReadonlySet<string> | undefined;
  try {
    // Cache-shared with the site's review-lane resolution, so this is a struct build, not a read.
    const ir = await resolveWorkflowIrForTask(store, task.id, options.irCache, options.selectionCache);
    if (ir) {
      requiredPreMergeStepIds = resolveRequiredPreMergeStepIds(ir, task.enabledWorkflowSteps, task);
      const lanes = new Set([...columnsWithFlag(ir, "intake"), ...columnsWithFlag(ir, "hold")]);
      if (lanes.size > 0) planningColumns = lanes;
    }
  } catch {
    /* No gate answer: the merge probe keeps the legacy results-only semantics. */
  }
  return deriveTaskStallReason(task, {
    now: options.now,
    reviewColumns: options.reviewColumns,
    lifecycleColumns: options.lifecycle,
    requiredPreMergeStepIds,
    autoMergeAllowed: allowsAutoMergeProcessing(task, options.settings),
    planningColumns,
    suppressed: options.suppressed,
    resolveDependency,
    satisfactionColumnsByTaskId,
  } satisfies TaskStallReasonContext);
}

/*
FNXC:ReviewLaneBypass 2026-09-03-13:15 (RUFU-179):
Per-row wiring for the bypass CAPABILITY, shared by all four hydration sites so the board, the
detail modal, the incremental stream, and search all answer with exactly what the store's
`bypassFailedPreMergeReviewStep` would accept today — one `deriveReviewBypassTarget` call with the
store's own lane rule (`resolveReviewBypassLanes`, NOT the diagnostic `resolveReviewColumnsForTask`
union that always includes the legacy `"in-review"` id) and the store's own required-gate set.

Deliberate asymmetry with the sibling stall signals above: this one is NEVER suppressed on
merge-queue membership or fresh agent-log activity. A diagnostic must stop shouting while a merger
is streaming logs; an escape hatch must stay reachable on exactly the wedged card it exists for.

Cost: the IR struct is already warm per pass — every row pays `resolveReviewColumnsForTask` for the
stall badges — so the only new work is one pure `resolveRequiredPreMergeStepIds` pass, gated to
rows that are not operator-held and whose column is actually in a bypass lane. Fail-soft on
IR-resolution throw: the affordance disappears, the board never fails to render.
*/
async function resolveReviewBypassForTask(
  store: TaskStore,
  task: Task,
  irCache: Map<string, WorkflowIr>,
  selectionCache?: WorkflowSelectionCache,
): Promise<ReviewBypassTarget | undefined> {
  /*
  FNXC:ReviewLaneBypass 2026-09-10-23:19 (RUFU-218):
  The OPERATOR-HOLD early return: a hand-placed hold suppresses the capability, while an
  engine-originated park (`paused` with `userPaused` unset) no longer does. Reading the bare `paused`
  flag here hid the menu item on exactly the card whose stall diagnostic names this escape hatch, and
  the store then refused it with `task is paused` — the same false answer from both sides of the
  offer==accept invariant this helper exists to keep. The predicate is shared with the store's own
  refusal so the two cannot drift; reasoning at `merge/review-bypass-target.ts`. Still needs no IR, so
  it answers most of a board before the first workflow read.
  */
  if (isOperatorPausedForOperatorEscapeHatch(task)) return undefined;
  try {
    const ir = await resolveWorkflowIrForTask(store, task.id, irCache, selectionCache);
    const lanes = resolveReviewBypassLanes(ir);
    if (!lanes.includes(task.column)) return undefined;
    const requiredStepIds = ir
      ? resolveRequiredPreMergeStepIds(ir, task.enabledWorkflowSteps, task)
      : new Set<string>();
    /*
    FNXC:PostMergeGateOperatorWaiver 2026-09-29-15:49 (RUFU-408):
    The required POST-merge set is passed so the affordance matches the store on the gate that holds a
    LANDED card out of `done` — the RUFU-179 invariant (UI eligibility == store acceptance) is only real
    if both sides ask about the same gates. Cost is one more pure pass over the already-resolved IR, on
    rows that are neither operator-held nor outside a bypass lane.
    */
    const requiredPostMergeStepIds = ir ? new Set(resolveRequiredPostMergeGateIds(task, ir)) : new Set<string>();
    return deriveReviewBypassTarget(task, requiredStepIds, new Set(lanes), requiredPostMergeStepIds);
  } catch {
    return undefined;
  }
}

/**
 * FNXC:TaskRecommendations 2026-08-13-22:23:
 * Claim replay is a one-row indexed lookup and intentionally skips cold storage: archive
 * snapshots have no proposalClaimId. It also skips board-derived signal hydration because replay needs only persisted data.
 */
export async function findTaskByProposalClaimIdImpl(store: TaskStore, proposalClaimId: string, options?: { includeDeleted?: boolean }): Promise<Task | null> {
  if (proposalClaimId.trim().length === 0) return null;
  const row = await readTaskRowByProposalClaimId(store.asyncLayer!, proposalClaimId, options);
  return row ? store.rowToTask(store.pgRowToTaskRow(row)) : null;
}

export async function listTasksBySourceLineageImpl(store: TaskStore, input: { sourceAgentId?: string | null; sourceParentTaskId?: string | null }): Promise<Task[]> {
  const rows = await readTaskRowsBySourceLineage(store.asyncLayer!, input);
  return rows.map((row) => store.rowToTask(store.pgRowToTaskRow(row)));
}

export async function getTaskImpl(store: TaskStore, id: string, options?: { activityLogLimit?: number; includeDeleted?: boolean }): Promise<TaskDetail> {
    return store.withTaskLock(id, async () => {
      // FNXC:RuntimePersistenceAsync 2026-06-24-10:50:
      // Backend-mode getTask: read the task row via async helper, convert to
      // Task via pgRowToTaskRow + rowToTask, and hydrate derived fields.
            const layer = store.asyncLayer!;
      const pgRow = await readTaskRow(layer, id, {
        includeDeleted: options?.includeDeleted,
      });
      if (!pgRow) {
        /*
        FNXC:TaskLookup404 2026-07-26-11:20:
        Missing and soft-deleted tasks are absent from the live task-detail model. Historical snapshots
        remain internal migration/forensic records and cannot resurrect a deleted card through getTask.
        */
        throw new TaskNotFoundError(id);
      }
      const task = store.rowToTask(store.pgRowToTaskRow(pgRow));
      const now = Date.now();
      const settings = await store.getSettingsFast();
      const mergeQueuedTaskIds = await store.getMergeQueuedTaskIdsAsync();
      /*
      FNXC:WorkflowLifecycle 2026-07-05-15:40:
      In-review merge/review agents stream progress to agent-log JSONL without
      necessarily mutating the task row. Treat fresh agent-log writes as active
      ownership for stall-badge hydration so the board does not show
      Stalled/Merge stalled while a merger is visibly making progress. Restores
      main's FNXC:WorkflowLifecycle 2026-07-01-23:27 behavior, which the
      PostgreSQL cutover's store split predated.
      */
      /* FNXC:WorkflowLifecycleColumns 2026-07-31-01:20 (fleet): hoisted ABOVE the fresh-activity gate
         so that gate can resolve too — it is now the FIRST signal, and the note below is the rule. */
      // FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174): one IR cache for this detail read — review
      // lanes, the stall derivation's required-gate ids, and any dependency-satisfaction lanes all
      // share it, so the card's workflow is read once no matter how many signals want it.
      // FNXC:TaskReadsThreading 2026-09-06 (merge origin/main dd808ed2c6): the same single-pass rule
      // now covers the workflow-SELECTION cache — upstream's resolver signature takes a 4th cache
      // argument and `reads-selection-cache-threading.test.ts` ratchets that every >2-arg call sites
      // threads it, so the detail path pairs detailIrCache with its own selection cache.
      const detailIrCache = new Map<string, WorkflowIr>();
      const detailSelectionCache = new Map<string, import("../workflows/workflow-ir-resolver.js").WorkflowSelection | undefined>();
      const reviewColumnsForTask: InReviewStallContext["reviewColumns"] = await resolveReviewColumnsForTask(store, task.id, detailIrCache, detailSelectionCache);
      const hasFreshAgentLogActivity = hasFreshAgentLogActivitySinceTaskUpdate(store, task, now, reviewColumnsForTask);
      const executingTaskIds = hasFreshAgentLogActivity ? new Set<string>([task.id]) : undefined;
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-20:50:
      RESOLVED BEFORE THE FIRST SIGNAL, because two adjacent signals must not disagree.

      This resolve sat BELOW the `getInReviewStallReason` call, so that one call could not pass
      `reviewColumns` and silently kept the legacy single-lane fallback — while
      `getInReviewStalledSignal` three lines down received the resolved SET. On a board declaring a
      separate merge lane beside its human-review lane, `inReviewStall` would read the first review
      column only and `inReviewStalled` would read both, so the same card is "in review" for one
      signal and not the other. Two signals disagreeing is worse than both being legacy, and it is
      invisible on every builtin board because there the set has exactly one element.

      Measured before fixing: of the four `getInReviewStallReason` call sites in this file
      (227/390/599/729) this was the ONLY one not passing the lanes — the other three already did.
      */
      /*
      Typed against the exported context interfaces on purpose: `unwired-lane-parameter-guard` keys an
      interface member to its OWNER symbol and only counts a mention from a file that also names that
      owner (unwired-lane-parameter.mjs:175). Passing the property inline — as this file did — reads as
      UNWIRED even when every call site supplies it, which is how two of the three declarations landed
      on that ratchet while genuinely wired. Naming the types is the smaller fix than appending to a
      list the guard says may only ever shorten.
      */
      task.inReviewStall = mergeQueuedTaskIds.has(task.id)
        ? undefined
        : getInReviewStallReason(task, {
          now,
          executingTaskIds,
          reviewColumns: reviewColumnsForTask,
          requiredPreMergeStepIds: await resolveStallGateIdsForTask(store, task, detailIrCache, detailSelectionCache),
          autoMerge: allowsAutoMergeProcessing(task, settings),
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        });
      task.inReviewStalled = mergeQueuedTaskIds.has(task.id)
        ? undefined
        : getInReviewStalledSignal(task, {
          now,
          executingTaskIds,
          reviewColumns: reviewColumnsForTask,
          thresholdMs: settings.inReviewStalledThresholdMs,
          autoMerge: allowsAutoMergeProcessing(task, settings),
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        } satisfies InReviewStalledContext);
      task.stalledReview = mergeQueuedTaskIds.has(task.id) || hasFreshAgentLogActivity ? undefined : detectStalledReview(task, { now, reviewColumns: reviewColumnsForTask });
      task.retrySummary = computeRetrySummary(task);
      /*
      FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174):
      The canonical "why is this card standing still" answer. Like every sibling signal above it,
      it is evaluated on the PERSISTED steps — the PROMPT.md step sync below can only ADD steps,
      and all four hydration sites keep the same pre-sync evaluation point so the answer cannot
      drift between the detail view and the board. Suppression mirrors `stalledReview` two lines
      up (merge-queued OR fresh agent-log activity), NOT `inReviewStall`'s narrower merge-queue
      gate: a card whose merger is streaming logs is not standing still, whatever its row says.
      */
      task.stallReason = await hydrateTaskStallReason(store, task, {
        now,
        settings,
        suppressed: mergeQueuedTaskIds.has(task.id) || hasFreshAgentLogActivity,
        reviewColumns: reviewColumnsForTask,
        lifecycle: await resolveTaskLifecycleColumns(store, task.id, detailIrCache, detailSelectionCache),
        irCache: detailIrCache,
        selectionCache: detailSelectionCache,
        localColumnByTaskId: new Map([[task.id, task.column]]),
      });
      /* FNXC:ReviewLaneBypass 2026-09-03-13:15 (RUFU-179): detail-view parity with the board feed.
         Not suppressed on merge-queue or activity — the capability must survive the wedge it is for. */
      task.reviewBypass = await resolveReviewBypassForTask(store, task, detailIrCache, detailSelectionCache);
      /*
      FNXC:TaskDetailPromptResilience 2026-07-10-15:00 (merge port from main):
      PROMPT.md is enrichment for the task detail — NOT essential row data.
      getTask is the shared load for the entire per-task API, so an unguarded
      read/parse throw here turned every per-task operation into a 500 while
      the PROMPT.md-free board list kept working. A read can fail for reasons
      unrelated to the row (EACCES from a root-owned file, EISDIR, symlink
      loop, transient FS error). Degrade to empty prompt / unsynced steps.
      */
      if (task.steps.length === 0) {
        try {
          task.steps = await store.parseStepsFromPrompt(id);
        } catch (err) {
          // FNXC:ListReadPromptParseCache 2026-10-02-11:59 (RUFU-495): a malformed PROMPT.md stays malformed, so this
          // warning used to repeat on every read of the same card (~1.7 lines/s on the production board). Same
          // signal, once per card.
          const detail = `failed to sync steps from PROMPT.md for ${id}: ${err instanceof Error ? err.message : String(err)}`;
          if (shouldWarnPromptParseFailure(store, id, detail)) storeLog.warn(`[task-detail] ${detail}`);
        }
      }
      let prompt = "";
      try {
        const promptPath = join(store.taskDir(id), "PROMPT.md");
        if (existsSync(promptPath)) {
          prompt = await readFile(promptPath, "utf-8");
        }
      } catch (err) {
        storeLog.warn(`[task-detail] failed to read PROMPT.md for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { ...task, prompt };
});
  }

export interface ListTasksOptions {
  limit?: number;
  offset?: number;
  /** Exclusive createdAt/id tuple used by bounded Board pages. */
  afterCreatedAt?: string;
  afterId?: string;
  /** Exclusive keyset for the shared queue orders (see `task-queue-order-ops.ts`). */
  afterQueueKey?: TaskQueuePageKey;
  afterIntakeKey?: Pick<TaskQueuePageKey, "createdAt" | "id">;
  /** Historical compatibility snapshots participate only when explicitly requested. */
  includeArchived?: boolean;
  /** Omit heavy detail fields for board-style consumers. */
  slim?: boolean;
  /** Restrict to one or several custom-capable column ids. */
  column?: ColumnId;
  columns?: readonly ColumnId[];
  /** Exclude one or several custom-capable column ids. */
  excludeColumns?: readonly ColumnId[];
  /** Select the SQL page by creation or latest completion-lane entry. */
  sort?: "created-asc" | "completion-desc" | "completion-date-desc" | "queue-order" | "intake-desc";
  startupMemo?: boolean;
  /** Caller-owned per-pass workflow IR cache; shared only within one read pass. */
  irCache?: Map<string, WorkflowIr>;
  /** Observed definition reads issued during this list pass (zero for warm/builtin IRs). */
  definitionReadTally?: WorkflowDefinitionReadTally;
  /** Forensic-only: include soft-deleted rows. */
  includeDeleted?: boolean;
  /*
  FNXC:WorkflowScheduling 2026-09-06-09:41:
  FN-9261 lets a caller own the per-pass workflow-selection cache and read tally so a list
  hydration batches selection reads once instead of issuing one per row. Both stay optional:
  an omitted cache means the pass allocates its own and the tally is simply not reported.
  */
  selectionCache?: WorkflowSelectionCache;
  selectionReadTally?: WorkflowSelectionReadTally;
  /*
  FNXC:BoardFeedCompaction 2026-09-17-14:49:
  Board/search feed only renders step identity/status (workflow badges, progress bar, memo diff)
  and never a step body, yet every lane row carried reviewer `output`, `notes`, `findings` and
  `priorAttempts` snapshots plus the per-column `summary`: together 61 % of the live Done-lane
  payload (380 KB results + 159 KB summary out of 912 KB). `compactBoardFeed` strips those four
  bodies and `summary` AFTER the row-level derivations — `computeRetrySummary` counts
  `priorAttempts`, so stripping earlier would change derived badges. Omitted means full shape:
  engine `listTasks` consumers (WIP lane tool, dispatch gates) keep reading real bodies.
  */
  compactBoardFeed?: boolean;
  /*
  FNXC:ListTasksDeriveOptOut 2026-09-08-20:58 (RUFU-201):
  Engine timer consumers (triage poll, scheduler tick, gridlock sweep, lane-role sweep) never read a
  UI-only derived board signal, yet every tick paid nine per-row derivations anyway. Those derivations
  are also the ONLY producers of the `task_workflow_selection` and `workflow_prompt_overrides` reads,
  which measured 31.8% and 41.7% of all in-flight statements on a live 22-project instance — the
  overrides table was empty. `derive: false` skips the derivation block AND its pass-level feeders
  (settings, merge-queue set, IR cache, selection prefetch, page-local column map), while keeping the
  SQL fetch, row parsing, slim steps-from-PROMPT.md sync and the `log: []` output shape; derived
  fields stay undefined. Omitted means `true`, because the dashboard board feed must keep every badge
  it renders today — board parity is the hard constraint, so the opt-out is always caller-opt-in.
  */
  derive?: boolean;
  /*
  FNXC:ListTasksExcludeLog 2026-10-10-19:13 (RUFU-615): SUPERSEDES the "documented no-op" contract.
  `excludeLog: true` is now effective on its own. It used to be gated behind `derive: false` because
  `log` was a derivation INPUT — `stalledReview`, `inReviewStall*` and `timedExecutionMs` were computed
  from log entries before any wire stripping, so dropping the column would have silently disabled two
  board badges (FNXC:TaskStoreReads 2026-07-05-15:30). Those five derivations now read the write-time
  columns `timing_total_ms` and `log_recent` instead (see `task-store/task-log-projections.ts`), so a
  deriving caller can ask for a `log`-free row and still get byte-identical badges — proven by
  `__tests__/postgres/task-log-projections.pg.test.ts`.

  `slim` alone still does NOT drop the column while deriving: engine sweeps call `listTasks({slim:true})`
  with derivation left on and read `log` MARKERS out of the rows they get back, so flipping `slim`
  would prune a column a shared loader's consumers still read. Only an explicit `excludeLog` does that,
  per call site, which keeps every existing caller's SQL shape untouched.

  This is still deliberately NOT `slim: true`: `slim` bundles three unrelated contracts, and the one
  that matters here is `finalizeSlimListTask`, which re-parses PROMPT.md for EVERY task whose persisted
  `steps` is empty — an unbounded per-pass file read whose cost is only knowable from a live census.
  A consumer that wants badges and no log wants `excludeLog`, not `slim`.
  */
  excludeLog?: boolean;
}

/*
FNXC:ListTasksDeriveOptOut 2026-09-08-20:58 (RUFU-201):
Pass-level inputs for the derived-signal block ONLY. Each one is a per-pass cost that pays for
itself solely through board badges, which is why `derive: false` never calls this builder. The
profile behind the task measured 281.9 MB / 240 s of short-lived allocations in `listTasksImpl`
and ~19% of CPU in GC, while the live server showed 73.5% of in-flight statements spent on the
selection/override reads these feeders drive.

FNXC:MemoryDiagnosis 2026-10-10-18:52 (RUFU-627):
"short-lived" was the wrong word, and this sentence is why the growth was read as churn for weeks.
A V8 sampling heap profiler run (live samples; samples of collected objects are dropped) over 281 s on
the production process attributed 1.327 GiB of STILL-LIVE allocations to this path: `rowToTask` 0.625 GiB
via `listTasksImpl -> map -> rowToTask`, `DataRow` 0.343 GiB retained from `(root) -> onStreamRead` (the
wire bytes of the same query), `fromJson` 0.218 GiB, `parse` 0.105 GiB -- everything outside this path was
<= 0.013 GiB. The forced-GC floor of that process rose live +33 MiB/min and old_space +27 MiB/min while
large_object_space, new_space, external and arrayBuffers all fell. A `dashboard --no-engine` shadow on the
same DB plateaus at 1.28 GiB across 18 concurrent full-project reads and returns to 0.80 GiB when idle, so
the allocation is pinned only while engine consumers overlap: one fully parsed board is ~0.58 GiB for 2417
rows, ~240 KB of heap per Task against ~30 KB of stored row. Treat this path as retention-capable, not transient.

/*
FNXC:WorkflowLifecycleColumns 2026-07-28-18:05 (PR #2479 review, P2):
ONE IR cache for the whole list pass. Without it, every paused row resolved
its workflow independently, repeating workflow-definition and prompt-override
reads for a board with many paused cards on the same workflow. Caller-owned by
design (U1's `resolveTaskLifecycleColumns` takes the cache for exactly this),
so reads scale with the number of WORKFLOWS, not the number of cards.

/*
FNXC:WorkflowScheduling 2026-09-05-23:12: List hydration prefetches once per pass; getTaskImpl remains individual because one row has no N+1. The tally reports store-internal reads to callers without changing badge fallback semantics.

/*
FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174): the stall derivation's dependency resolver
answers any reference covered by THIS page from the page's own rows — a board feed normally
carries a blocker and its blocked card together, so the common case stays zero-read. Built
from the raw rows because `pgRowToTaskRow` would parse every step/JSON column twice.

/*
FNXC:SqliteFinalRemoval 2026-06-26-10:30:
Compute staleness thresholds once for the whole list pass, mirroring the SQLite path. The
ageStaleness/stalePausedReview/stalePausedTodo signals are derived at read time and must be
hydrated in backend mode too (VAL-CROSS-001 board parity).
*/
type ListDeriveFeed = {
  settings: Settings;
  mergeQueuedTaskIds: Set<string>;
  listPassIrCache: Map<string, WorkflowIr>;
  listPassSelectionCache: WorkflowSelectionCache;
  localColumnByTaskId: Map<string, string>;
  staleThresholds: TaskAgeStalenessThresholds;
};

async function buildListDeriveFeed(
  store: TaskStore,
  filteredRows: Record<string, unknown>[],
  options?: ListTasksOptions,
): Promise<ListDeriveFeed> {
  const settings = await store.getSettingsFast();
  const mergeQueuedTaskIds = await store.getMergeQueuedTaskIdsAsync();
  /* FNXC:WorkflowScheduling 2026-09-09-15:13 (merge origin/main f59f9ead92 -> main): FN-9261 lets the caller
     own the per-pass IR cache and count store-internal definition reads. Both were added to the inline prelude
     upstream still had; RUFU-201 moved that prelude here, so they are honored here. */
  const listPassIrCache = options?.irCache ?? new Map<string, WorkflowIr>();
  const listPassSelectionCache = options?.selectionCache ?? new Map<string, import("../workflows/workflow-ir-resolver.js").WorkflowSelection | undefined>();
  const listSelectionReads = await prefetchWorkflowSelections(store, filteredRows.map((row) => String(row.id)), listPassSelectionCache);
  if (options?.selectionReadTally) {
    options.selectionReadTally.batched += listSelectionReads.batched;
    options.selectionReadTally.singles += listSelectionReads.singles;
  }
  /* FNXC:WorkflowScheduling 2026-09-05-23:12: one IR read per definition per pass, not per row; the tally
     reports store-internal reads to callers without changing badge fallback semantics. */
  await prefetchWorkflowIrs(store, filteredRows.map((row) => String(row.id)), listPassIrCache, listPassSelectionCache, options?.definitionReadTally);
  const localColumnByTaskId = new Map<string, string>();
  for (const pgRow of filteredRows) {
    if (typeof pgRow.id === "string" && typeof pgRow.column === "string") {
      localColumnByTaskId.set(pgRow.id, pgRow.column);
    }
  }
  const staleThresholds: TaskAgeStalenessThresholds = {
    inProgressWarningMs: settings.staleInProgressWarningMs,
    inProgressCriticalMs: settings.staleInProgressCriticalMs,
    inReviewWarningMs: settings.staleInReviewWarningMs,
    inReviewCriticalMs: settings.staleInReviewCriticalMs,
  };
  return { settings, mergeQueuedTaskIds, listPassIrCache, listPassSelectionCache, localColumnByTaskId, staleThresholds };
}

/*
FNXC:ListTasksDeriveOptOut 2026-09-08-20:58 (RUFU-201):
The list-read tail shared by the derived and opted-out paths, so opting out cannot also change the
`steps` contract. Kept as a plain function (not a component/nested closure) so both callers
reconcile the same shape.

/*
FNXC:TaskDetailPromptResilience 2026-07-10-16:00 (merge port from main):
an unreadable PROMPT.md must not reject this Promise.all and 500 the
entire board list — degrade to the persisted (empty) steps and log.
*/
async function finalizeSlimListTask(store: TaskStore, task: Task, slim: boolean): Promise<Task> {
  if (!slim || task.steps.length > 0) {
    return task;
  }
  try {
    const steps = await store.parseStepsFromPrompt(task.id);
    return steps.length > 0 ? { ...task, steps } : task;
  } catch (err) {
    // FNXC:ListReadPromptParseCache 2026-10-02-11:59 (RUFU-495): a malformed PROMPT.md stays malformed, so this
    // warning used to repeat on every read of the same card (~1.7 lines/s on the production board). Same
    // signal, once per card.
    const detail = `failed to sync steps from PROMPT.md for ${task.id} during listTasks: ${err instanceof Error ? err.message : String(err)}`;
    if (shouldWarnPromptParseFailure(store, task.id, detail)) storeLog.warn(`[task-detail] ${detail}`);
    return task;
  }
}

export async function listTasksImpl(store: TaskStore, options?: ListTasksOptions): Promise<Task[]> {
    /*
    FNXC:TaskArchiveRemoval 2026-09-04-18:25:
    Ordinary task reads are live-only by default. Cold archive snapshots remain available solely to
    explicit migration and forensic callers; an omitted compatibility flag must never resurrect
    historical rows into schedulers, APIs, or workflow scans.
    */
    const includeArchived = options?.includeArchived ?? false;
    const slim = options?.slim ?? false;
    const columnFilter = options?.column;
    // FNXC:ListTasksDeriveOptOut 2026-09-08-20:58 (RUFU-201): see `derive` on ListTasksOptions.
    const deriveUiSignals = options?.derive !== false;
    const startupMemoEnabled = options?.startupMemo ?? (!store.isWatching && slim);

    if (startupMemoEnabled && slim && options?.limit === undefined && options?.offset === undefined) {
      const memoKey = [
        includeArchived ? "all" : "active",
        columnFilter ?? "*",
        options?.columns?.join(",") ?? "*",
        options?.excludeColumns?.join(",") ?? "*",
        options?.sort ?? "created-asc",
        // FNXC:ListTasksDeriveOptOut 2026-09-08-20:58 (RUFU-201): a derived snapshot must never
        // serve an opted-out caller, nor a raw one the board. `derive` is part of the result shape.
        deriveUiSignals ? "derive" : "raw",
        /*
        FNXC:StartupSlimListMemo 2026-09-09-03:55 (RUFU-201 code-review remediation):
        `includeDeleted` is a result-shape dimension of the memo key. Soft deletion stamps the
        historical `archived` sentinel column, so a non-`includeArchived` read hides tombstones via
        the column filter as well; the shapes that actually diverge are `includeArchived: true`
        reads (admin/forensic surfaces, e.g. `?includeDeleted=true`), where only `deleted_at IS
        NULL` separates live from forensic. Sharing one entry across that pair serves either caller
        the other's tombstone set for up to one TTL. The collision pre-dated RUFU-201 but its TTL
        raise (2.5 s -> 15 s) widened the wrong-payload window sixfold.
        */
        options?.includeDeleted ? "deleted" : "live",
      ].join(":");
      const now = Date.now();
      const cached = store.startupSlimListMemo.get(memoKey);
      if (cached && cached.expiresAt > now) {
        /*
        FNXC:StartupSlimListMemo 2026-09-08-21:35 (RUFU-201):
        The hit path deep-copied the snapshot through JSON on EVERY hit — for a board that is the
        whole payload parsed and re-stringified per call (the RunFusion board measured ~5.4 MB),
        which is exactly the short-lived allocation churn the profile blamed for ~19% of CPU in GC.
        A snapshot is frozen at fill time and shared as-is, so a hit costs one awaited promise.
        Consumers therefore get a read-only view of a memoized board list: mutating one now throws
        instead of silently handing the next consumer a mutated row.
        */
        return await cached.promise;
      }

      const fetchPromise = (async () => {
        const memoTasks = await store.listTasks({ ...options, startupMemo: false });
        /*
        FNXC:StartupSlimListMemo 2026-09-08-21:35 (RUFU-201): freeze ONCE at fill, not per hit
        (KTD-4). A board snapshot is rebuilt from the row each read — the derived badges a caller
        might have wanted to change are recomputed, never patched onto the cache.
        */
        for (const memoTask of memoTasks) Object.freeze(memoTask);
        return Object.freeze(memoTasks) as Task[];
      })();
      store.startupSlimListMemo.set(memoKey, {
        expiresAt: now + TaskStore.STARTUP_SLIM_LIST_MEMO_TTL_MS,
        promise: fetchPromise,
      });
      try {
        return await fetchPromise;
      } catch (error) {
        store.startupSlimListMemo.delete(memoKey);
        throw error;
      }
    }

    // FNXC:RuntimePersistenceAsync 2026-06-24-10:55:
    // Backend-mode listTasks: read live task rows via async helper, convert to
    // Tasks, and hydrate derived fields.
        const layer = store.asyncLayer!;
    /*
    FNXC:TaskStoreReads 2026-07-05-15:30:
    The `log` column must be fetched even in slim mode: the server derives
    `stalledReview` (reenqueue-churn / invalid-transition heuristics) and
    `timedExecutionMs` from log entries BEFORE stripping the log from the
    wire response, exactly like the SQLite path's slim projection (which
    also selected `log` for this reason). The earlier `excludeLog: slim`
    optimization silently disabled both signals on board listings.
    Pass `includeDeleted` through for forensic reads (VAL-DATA-006).

/*
    FNXC:TaskStoreReadsPerf 2026-07-11 (PR #1793 review):
    The column filter and pagination are pushed into SQL (readLiveTaskRows
    WHERE + ORDER BY + LIMIT/OFFSET) instead of fetching the whole table and
    filtering/slicing here — out-of-page rows no longer pay wire transfer or
    per-task hydration (stall signals, PROMPT.md step sync). The SQL order
    (created_at, numeric id suffix) matches the JS comparator below, so the
    page content is identical to the old client-side slice.
    */
    const paginationOffset = Math.max(0, options?.offset ?? 0);
    const paginationLimit = options?.limit !== undefined ? Math.max(0, options.limit) : undefined;
    /*
    FNXC:TaskArchiveRemoval 2026-09-04-18:25 DELIBERATE-LITERAL:
    Explicit migration/forensic reads compose live rows with cold snapshots before global pagination.
    A column filter admits cold storage only when it names the historical sentinel; no workflow
    archive role participates.
    */
    const historicalSentinels = ARCHIVED_SENTINEL_LANES;
    const columnFilterIsHistorical = columnFilter !== undefined
      && (historicalSentinels && historicalSentinels.size > 0 ? historicalSentinels : LEGACY_ARCHIVE_LANES).has(columnFilter);
    const includeColdStorage = includeArchived && (!columnFilter || columnFilterIsHistorical);
    const boundedMergedPrefix = includeColdStorage && paginationLimit !== undefined
      ? paginationOffset + paginationLimit
      : undefined;
    const sqlPaginated = (!includeColdStorage && (paginationLimit !== undefined || paginationOffset > 0))
      || boundedMergedPrefix !== undefined;
    /*
    FNXC:ListTasksDeriveOptOut 2026-09-08-20:58 (RUFU-201):
    `log` has exactly two readers in this function — the `stalledReview` derivation and slim's
    `timedExecutionMs` — so an opted-out slim consumer needs none of it and the projection drops it
    (avg 11 KB/row on the live table). `rowToTask` maps a missing column to `log: []`, so the row
    shape on the wire is unchanged. This does NOT revive `excludeLog: slim` for deriving consumers:
/*
    FNXC:TaskStoreReads 2026-07-05-15:30 above restored the log read precisely because dropping it
    silently disabled both signals on the board.

/*
    FNXC:ListTasksExcludeLog 2026-09-09-01:48 (RUFU-202):
    The `!deriveUiSignals` half of this condition stays load-bearing, but slim is no longer the only
    way to ask for the drop: an explicitly opted-out non-slim consumer may now request it per call
    site. So the gate is `derivation off AND (slim || caller asked)` — derivation on always keeps
    `log`, and derivation off only drops it when somebody declared they do not read it.

    FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
    The `!deriveUiSignals` veto is GONE, and that is the whole point of the two new columns. `log` was a
    derivation input only because the five log-derived signals were computed here; they now read
    `timing_total_ms` + `log_recent`, so an explicit `excludeLog: true` reaches the SELECT even while
    deriving and the badges stay byte-identical (proven in
    `__tests__/postgres/task-log-projections.pg.test.ts`). `slim` alone still cannot drop the column
    while deriving: the engine's `slim` sweeps read `task.log` MARKERS out of the rows they get back, and
    no shared loader may lose `log` — only a caller that asked per call site does.
    */
    const effectiveExcludeLog = options?.excludeLog === true || (!deriveUiSignals && slim);
    const filteredRows = await readLiveTaskRows(layer, {
      ...(effectiveExcludeLog ? { excludeLog: true } : {}),
      includeDeleted: options?.includeDeleted,
      column: columnFilter ?? undefined,
      columns: options?.columns,
      excludeColumn: !columnFilter && !options?.columns && !options?.excludeColumns && !includeArchived ? "archived" : undefined,
      excludeColumns: options?.excludeColumns,
      sort: options?.sort,
      afterCreatedAt: options?.afterCreatedAt,
      afterId: options?.afterId,
      afterQueueKey: options?.afterQueueKey,
      afterIntakeKey: options?.afterIntakeKey,
      ...(boundedMergedPrefix !== undefined
        ? { limit: boundedMergedPrefix, offset: 0 }
        : sqlPaginated
          ? { limit: paginationLimit, offset: paginationOffset }
          : {}),
    });
    const now = Date.now();
    /*
    FNXC:ListTasksDeriveOptOut 2026-09-08-20:58 (RUFU-201):
    Every pass-level input below existed only to feed the per-row derivation block. An opted-out
    consumer receives `null` and none of them runs: no settings read, no merge-queue set, no IR
    cache, no selection prefetch, no page-local column map.
    */
    /*
    FNXC:ListTasksDeriveOptOut 2026-09-09-15:13 (merge origin/main f59f9ead92 -> main):
    upstream's per-pass prelude (settings, merge-queue set, selection + IR prefetch, staleness thresholds) is
    the same block RUFU-201 extracted into `buildListDeriveFeed`, so it lives in that helper and stays behind
    the `deriveUiSignals` gate -- an opted-out caller runs none of it. upstream's `prefetchWorkflowIrs` /
    `definitionReadTally` additions were ported INTO the helper instead of re-inlined here, otherwise the
    caller-owned IR cache and definition tally would silently stop working.
    */
    const deriveFeed = deriveUiSignals
      ? await buildListDeriveFeed(store, filteredRows, options)
      : null;
    const tasks = await Promise.all(filteredRows.map(async (pgRow) => {
      const row = store.pgRowToTaskRow(pgRow);
      const task = store.rowToTask(row);
      /*
      FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
      Whether THIS row carried the column is what decides which path answers the log-derived signals —
      not an option flag, because the projection gate above already resolved the flag into a SELECT.
      `pgRowToTaskRow` hydrates an absent `log` to `[]`, which is otherwise indistinguishable from an
      empty history, so the check runs on the RAW row before mapping.

      With the column loaded, the log path below runs unchanged and byte-identical: the projection is
      never preferred over the data it was derived from. Equality of the two paths is asserted in tests
      (`task-log-projections.pg.test.ts`), never paid for on the hot read path.
      */
      const logLoaded = pgRow.log !== undefined;
      const logProjections = logLoaded ? null : parseTaskLogRecent(pgRow.logRecent);
      const timingTotalMs = typeof pgRow.timingTotalMs === "number" ? pgRow.timingTotalMs : 0;
      if (deriveFeed === null) {
        /*
        FNXC:ListTasksDeriveOptOut 2026-09-08-20:58 (RUFU-201):
        Parse-only row. No derivation runs, so every derived badge stays undefined by construction
        rather than by being reset — the cheapest proof that an opted-out caller cannot be silently
        served a stale signal, and the contract the zero-derivation-count regression test pins.
        */
        if (effectiveExcludeLog) task.log = [];
        return finalizeSlimListTask(store, task, slim);
      }
      const {
        settings,
        mergeQueuedTaskIds,
        listPassIrCache,
        listPassSelectionCache,
        localColumnByTaskId,
        staleThresholds,
      } = deriveFeed;
      const isMergeQueued = mergeQueuedTaskIds.has(task.id);
      /*
      FNXC:WorkflowLifecycle 2026-07-05-15:40:
      In-review merge/review agents stream progress to agent-log JSONL without
      necessarily mutating the task row. Treat fresh agent-log writes as active
      ownership for stall-badge hydration so the board does not show
      Stalled/Merge stalled while a merger is visibly making progress. Restores
      main's FNXC:WorkflowLifecycle 2026-07-01-23:27 behavior, which the
      PostgreSQL cutover's store split predated.
      */
      const reviewColumnsForRow = await resolveReviewColumnsForTask(store, task.id, listPassIrCache, listPassSelectionCache, options?.definitionReadTally);
      // FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174): resolved once per row, consumed by BOTH
      // ageStaleness (which had it inline) and the stall derivation below — same cache, one answer.
      const rowLifecycle = await resolveTaskLifecycleColumns(store, task.id, listPassIrCache, listPassSelectionCache);
      const hasFreshAgentLogActivity = hasFreshAgentLogActivitySinceTaskUpdate(store, task, now, reviewColumnsForRow);
      const executingTaskIds = hasFreshAgentLogActivity ? new Set<string>([task.id]) : undefined;
      task.inReviewStall = isMergeQueued ? undefined : getInReviewStallReason(task, {
        now,
        reviewColumns: reviewColumnsForRow,
        requiredPreMergeStepIds: isMergeQueued ? undefined : await resolveStallGateIdsForTask(store, task, listPassIrCache, listPassSelectionCache),
        executingTaskIds,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.stalePausedReview = getStalePausedReviewSignal(task, {
        now,
        thresholdMs: settings.stalePausedReviewThresholdMs,
        reviewColumns: reviewColumnsForRow,
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      } satisfies StalePausedReviewContext);
      task.inReviewStalled = isMergeQueued ? undefined : getInReviewStalledSignal(task, {
        now,
        executingTaskIds,
        reviewColumns: reviewColumnsForRow,
        thresholdMs: settings.inReviewStalledThresholdMs,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
        logLoaded,
        projection: logProjections,
      } satisfies InReviewStalledContext);
      task.stalePausedTodo = getStalePausedTodoSignal(task, {
        now,
        thresholdMs: settings.stalePausedTodoThresholdMs,
        // Paused-only (the signal is a no-op otherwise), sharing the list-pass
        // IR cache so one workflow is read once per pass, not once per card.
        holdColumn:
          task.paused === true ? await resolveHoldColumnForTask(store, task.id, listPassIrCache, listPassSelectionCache) : undefined,
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      /*
      FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
      Guard age-staleness: invalid threshold pairs throw RangeError — swallow so one bad setting cannot 500 the whole board list.
      */
      try {
        /*
        FNXC:WorkflowResolvedColumns 2026-07-30-08:10 (fleet phase):
        Resolved through the SAME per-pass `listPassIrCache` the hold-column read above already uses, so
        one workflow is read once per pass rather than once per card.

        Cost stated: the hold-column read is conditional on `task.paused`, this one is not, because the
        lanes it needs are exactly what decides whether the signal applies at all — there is no cheaper
        gate available ahead of it. With the cache that is a struct build per card, not an IR read.
        */
        task.ageStaleness = getTaskAgeStalenessSignal(task, {
          now,
          thresholds: staleThresholds,
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
          lifecycle: rowLifecycle,
        });
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        task.ageStaleness = undefined;
      }
      task.stalledReview = isMergeQueued || hasFreshAgentLogActivity ? undefined : detectStalledReview(task, { now, reviewColumns: reviewColumnsForRow, logLoaded, projection: logProjections });
      task.retrySummary = computeRetrySummary(task);
      /* FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174): parity with getTaskImpl above — same
         helper, same inputs, same suppression rule (merge-queued OR fresh agent-log activity),
         so the slim board row carries the identical reason the detail read shows. */
      task.stallReason = await hydrateTaskStallReason(store, task, {
        now,
        settings,
        suppressed: isMergeQueued || hasFreshAgentLogActivity,
        reviewColumns: reviewColumnsForRow,
        lifecycle: rowLifecycle,
        irCache: listPassIrCache,
        selectionCache: listPassSelectionCache,
        localColumnByTaskId,
      });
      /* FNXC:ReviewLaneBypass 2026-09-03-13:15 (RUFU-179): board-feed capability hydration. Derived
         BEFORE the slim strip below — the slim SQL projection still selects `workflow_step_results`
         (only `log` is dropped), so the derivation sees the same real results the full read does,
         and the capability reaches the slim board row the context menu renders from. */
      task.reviewBypass = await resolveReviewBypassForTask(store, task, listPassIrCache, listPassSelectionCache);
      if (slim) {
        /*
        FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
        `timedExecutionMs` is the only figure that summed the WHOLE log, which is why `timing_total_ms`
        is unwindowed and maintained per write. When the column was loaded the same exported function
        still runs over it; when it was not, the stored sum answers with the identical arithmetic.
        */
        task.timedExecutionMs = logLoaded ? store.computeTimedExecutionMs(task.log) : timingTotalMs;
        task.log = [];
      }
      if (options?.compactBoardFeed) compactBoardFeedRow(task);
      return finalizeSlimListTask(store, task, slim);
    }));
    // Sort by createdAt, then by numeric ID suffix for tie-breaking
    /*
    FNXC:PostgresArchiveReadPerformance 2026-07-14-17:50:
    A global page ending at K can only contain rows from each source's first K entries. Bound both SQL reads to K, then apply live-ID authority and the exact shared comparator before slicing. Unbounded callers retain the complete-result contract.
    */
    /* FNXC:TaskQueueOrder 2026-09-17-12:07: every SQL-ordered mode is already final; only the
       default created-ascending merge below needs the cold-storage composition pass. */
    if (!includeColdStorage && (
      options?.sort === "completion-desc"
      || options?.sort === "completion-date-desc"
      || options?.sort === "queue-order"
      || options?.sort === "intake-desc"
    )) return tasks;
    const archiveEntries = includeColdStorage
      ? boundedMergedPrefix !== undefined
        ? await listArchivedTasksByCreatedOrder(layer.db, boundedMergedPrefix, layer.projectId)
        : await listArchivedTaskEntries(layer.db, layer.projectId)
      : [];
    const archivedTasks = archiveEntries.map((entry) => store.archiveEntryToTask(entry, slim));
    // Match the legacy merge invariant: a forensic live row is authoritative
    // when the same id also has an archive snapshot.
    const sorted = mergePrimaryById(tasks, archivedTasks).sort((a, b) => {
      const cmp = a.createdAt.localeCompare(b.createdAt);
      if (cmp !== 0) return cmp;
      const aNum = parseInt(a.id.slice(a.id.lastIndexOf("-") + 1), 10) || 0;
      const bNum = parseInt(b.id.slice(b.id.lastIndexOf("-") + 1), 10) || 0;
      return aNum - bNum;
    });
    // Active-only pages were already bounded in SQL. Merged pages are sliced
    // here after composition so cold-storage rows share the same cursor.
    if (!includeColdStorage) return sorted;
    if (paginationLimit === undefined) return sorted.slice(paginationOffset);
    return sorted.slice(paginationOffset, paginationOffset + paginationLimit);
}

export interface TaskListPage {
  tasks: Task[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}

interface TaskListCursor {
  createdAt: string;
  id: string;
  query?: string;
  /** Canonical lane scope this page was cut for, so a cursor cannot cross columns. */
  lanes?: string;
}

function decodeTaskListCursor(value: string): TaskListCursor {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new TypeError("Invalid task list cursor"); }
  const cursor = parsed as { createdAt?: unknown; id?: unknown; query?: unknown; lanes?: unknown } | null;
  if (!cursor || typeof cursor.createdAt !== "string" || Number.isNaN(Date.parse(cursor.createdAt)) || typeof cursor.id !== "string" || !cursor.id) {
    throw new TypeError("Invalid task list cursor");
  }
  if (cursor.query !== undefined && typeof cursor.query !== "string") {
    throw new TypeError("Invalid task list cursor");
  }
  if (cursor.lanes !== undefined && typeof cursor.lanes !== "string") {
    throw new TypeError("Invalid task list cursor");
  }
  return {
    createdAt: cursor.createdAt,
    id: cursor.id,
    ...(typeof cursor.query === "string" ? { query: cursor.query } : {}),
    ...(typeof cursor.lanes === "string" && cursor.lanes ? { lanes: cursor.lanes } : {}),
  };
}

const MAX_TASK_LIST_LANES = 20;
const TASK_LIST_LANE_SCOPE_ERROR = "Invalid task list lane scope";

/**
 * FNXC:BoardLanePagination 2026-09-10-19:26:
 * A Board column must be able to page its own lane with a small page, so a page request can name
 * the lane ids it wants. One canonical signature (deduped, sorted, comma-joined) is used for both
 * the SQL scope and the cursor payload, because two spellings of the same lane set must not be
 * able to continue each other's page. RUFU-214.
 */
function normalizeTaskListLaneScope(columns?: readonly string[]): string | undefined {
  if (!columns || columns.length === 0) return undefined;
  const lanes = [...new Set(columns.map((column) => column.trim()).filter(Boolean))].sort();
  if (lanes.length === 0 || lanes.length > MAX_TASK_LIST_LANES) throw new TypeError(TASK_LIST_LANE_SCOPE_ERROR);
  return lanes.join(",");
}

/*
FNXC:TaskSearchPagination 2026-09-17-08:46:
FN-497: the header task search must present the most recently created match first, so the text lane orders by `created_at DESC, id DESC`.
The order and the keyset continuation predicate are ONE invariant: inverting only one of them makes pagination skip or repeat rows silently.
These two helpers are exported so the pair can be proven by rendering SQL without a database.
Board table pagination (the no-query branch) deliberately stays ascending and must not use them.
*/
export function buildTaskSearchPageOrder() {
  return [desc(schema.project.tasks.createdAt), desc(schema.project.tasks.id)] as const;
}

export function buildTaskSearchPageCursorPredicate(cursor?: { createdAt: string; id: string }) {
  if (!cursor) return undefined;
  return or(
    lt(schema.project.tasks.createdAt, cursor.createdAt),
    and(eq(schema.project.tasks.createdAt, cursor.createdAt), lt(schema.project.tasks.id, cursor.id)),
  );
}

/*
FNXC:TaskListPagination 2026-09-07-16:03:
Board task pages exclude completion history before the SQL limit and continue with an exclusive createdAt/id tuple. The exact count is independent of the page, while page hydration and workflow enrichment are paid only for returned rows.
*/
/*
FNXC:BoardFeedCompaction 2026-09-17-14:49:
GET /tasks/page is the Board and search feed. Board rows render step identity/status only —
workflow badges, progress bars, and the TaskCard memo comparator — never reviewer bodies. The
measured Done lane was 912 KB for 50 cards: `workflowStepResults` bodies (`output` 51 % of the
field, `priorAttempts` 23 %, `notes` 17 %, `findings` 6 %) plus the never-rendered `summary`
column carried ~61 % of those bytes. The full bodies remain one cheap hop away — the detail
modal fetches them per-open via GET /tasks/:id and GET /tasks/:id/workflow-results — so the
lane payload stops re-shipping them on every board poll. Call this AFTER row-level derivations
(stalledReview, retrySummary, reviewBypass): `computeRetrySummary` reads `priorAttempts`, so
the derived badge must see the history before the feed drops it. Identity/timing/status fields
stay so the client memo comparator and badges reconcile exactly as before.
*/
type BoardStepResult = NonNullable<Task["workflowStepResults"]>[number];

function compactBoardStepResult(result: BoardStepResult): BoardStepResult {
  if (result.output === undefined && result.notes === undefined && result.findings === undefined && result.priorAttempts === undefined) {
    return result;
  }
  const { output: _output, notes: _notes, findings: _findings, priorAttempts: _priorAttempts, ...carried } = result;
  return carried;
}

function compactBoardFeedRow(task: Task): void {
  task.workflowStepResults = (task.workflowStepResults ?? []).map(compactBoardStepResult);
  task.summary = undefined;
}

export async function listCurrentTasksPageImpl(store: TaskStore, options: { limit?: number; cursor?: string; query?: string; columns?: readonly string[] } = {}): Promise<TaskListPage> {
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 100) || 100));
  const cursor = options.cursor ? decodeTaskListCursor(options.cursor) : undefined;
  const query = options.query?.trim();
  if (cursor && (cursor.query ?? undefined) !== (query || undefined)) throw new TypeError("Invalid task list cursor");
  /*
  FNXC:BoardLanePagination 2026-09-10-19:26:
  Search spans lanes, so a searched page carries no lane scope and a lane-scoped cursor is refused
  once a query appears — continuing a 20-row column page into a search result set would skip rows
  the search ranked differently. RUFU-214.
  */
  const laneScope = query ? undefined : normalizeTaskListLaneScope(options.columns);
  if (cursor && (cursor.lanes ?? undefined) !== laneScope) throw new TypeError("Invalid task list cursor");
  const layer = store.asyncLayer;
  if (!layer) throw new Error("Task pagination requires the async task backend");

  /*
  FNXC:TaskSearchPagination 2026-09-07-17:38:
  Dashboard search uses a project-scoped createdAt/id keyset and applies the full-text predicate before LIMIT. The query is embedded in the opaque cursor so a cursor from another search scope is rejected rather than silently skipping matches after a filter change.
  */
  if (query) {
    const tsquery = buildTsqueryFragment(query);
    if (!tsquery) return { tasks: [], total: 0, hasMore: false, nextCursor: null };
    const searchPredicate = and(
      sql`${schema.project.tasks.searchVector} @@ ${tsquery}`,
      liveSearchPredicate(false, layer.projectId, ARCHIVED_SENTINEL_LANES),
      buildTaskSearchPageCursorPredicate(cursor),
    );
    const totalPredicate = and(
      sql`${schema.project.tasks.searchVector} @@ ${tsquery}`,
      liveSearchPredicate(false, layer.projectId, ARCHIVED_SENTINEL_LANES),
    );
    const [countRows, pageRows] = await Promise.all([
      layer.db.select({ count: sql<number>`count(*)::int` }).from(schema.project.tasks).where(totalPredicate),
      layer.db.select({ ...getTableColumns(schema.project.tasks) })
        .from(schema.project.tasks)
        .where(searchPredicate)
        .orderBy(...buildTaskSearchPageOrder())
        .limit(limit + 1),
    ]);
    const hasMore = pageRows.length > limit;
    const selectedRows = pageRows.slice(0, limit);
    const tasks = await hydrateSearchTaskRows(store, selectedRows, true, true);
    const last = tasks.at(-1);
    return {
      tasks,
      total: countRows[0]?.count ?? 0,
      hasMore,
      nextCursor: hasMore && last
        ? Buffer.from(JSON.stringify({ query, createdAt: last.createdAt, id: last.id }), "utf8").toString("base64url")
        : null,
    };
  }

  /*
  FNXC:BoardLanePagination 2026-09-10-19:26:
  With a lane scope the count and the page are both cut against exactly those columns, so a column's
  own total and `hasMore` describe that column instead of the whole board. The complete-lane lookup
  is skipped entirely: naming lanes makes it dead work on the hot board path. RUFU-214.
  */
  const laneColumns = laneScope ? laneScope.split(",") as ColumnId[] : undefined;
  const columnScope: { columns?: ColumnId[]; excludeColumns?: ColumnId[] } = laneColumns
    ? { columns: laneColumns }
    : { excludeColumns: [...await resolveProjectColumnsForRoles(store, ["complete"])] as ColumnId[] };
  const [total, rows] = await Promise.all([
    countLiveTasks(layer, columnScope),
    store.listTasks({
      ...columnScope,
      includeArchived: false,
      slim: true,
      /*
      FNXC:TaskLogProjections 2026-10-10-20:01 (RUFU-615): the hot board feed drops `log` while still
      deriving. Before RUFU-615 this combination was a documented no-op — the five log-derived signals
      were computed FROM the column, so asking for badges and the drop together returned the whole
      column (31.4 MB of 73.6 MB of live-row bytes, measured). They are now read from
      `timing_total_ms` + `log_recent`, both written with the log they summarise, so the badges survive
      the drop. `task-log-projections.pg.test.ts` proves the five figures are deep-equal either way.
      */
      excludeLog: true,
      compactBoardFeed: true,
      limit: limit + 1,
      sort: "created-asc",
      startupMemo: false,
      afterCreatedAt: cursor?.createdAt,
      afterId: cursor?.id,
    }),
  ]);
  const hasMore = rows.length > limit;
  const tasks = rows.slice(0, limit);
  const last = tasks.at(-1);
  return {
    tasks,
    total,
    hasMore,
    nextCursor: hasMore && last
      ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id, ...(laneScope ? { lanes: laneScope } : {}) }), "utf8").toString("base64url")
      : null,
  };
}

/*
FNXC:TaskQueueOrder 2026-09-17-13:51:
BOARD LANES ARE PAGED IN THEIR OWN ORDER. The generic board page is selected by creation ascending,
so a boosted card — or a freshly captured Ideas card — that starts beyond the limit is simply not in
the page, and no amount of client sorting can bring it to the head. This reader selects ONE lane
scope with the same SQL order the lane renders in (`queue` = Boost then arrival, `intake` = newest
first), so the head of every visible lane is loaded even for a project with thousands of live cards.

The continuation is the server's own opaque keyset, bound to project, order and lane membership: a
cursor minted for another lane or another order would interleave two total orders and silently skip
or repeat rows, so it is rejected rather than replayed.
*/
export type TaskQueuePageOrder = "queue" | "intake";

export interface TaskQueuePageOptions {
  /** The lane scope: one or more column ids that share this order. */
  columns: readonly string[];
  order?: TaskQueuePageOrder;
  limit?: number;
  cursor?: string;
}

type TaskQueueCursorPayload = {
  v: 1;
  projectId: string;
  order: TaskQueuePageOrder;
  scope: string;
  sequence: string;
  createdAt: string;
  id: string;
};

function taskQueueScopeSignature(columns: readonly string[]): string {
  return [...new Set(columns)].sort().join("\u0000");
}

function decodeTaskQueueCursor(cursor: string, projectId: string, order: TaskQueuePageOrder, scope: string): TaskQueueCursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<TaskQueueCursorPayload>;
    if (parsed.v !== 1 || parsed.projectId !== projectId || parsed.order !== order || parsed.scope !== scope
      || typeof parsed.id !== "string" || !parsed.id
      || typeof parsed.sequence !== "string" || !/^\d{1,32}$/.test(parsed.sequence)
      || typeof parsed.createdAt !== "string" || Number.isNaN(Date.parse(parsed.createdAt))) {
      throw new Error("mismatch");
    }
    return parsed as TaskQueueCursorPayload;
  } catch {
    throw new TypeError("Invalid task queue cursor");
  }
}

/** Return one keyset page of a single board lane scope, ordered in SQL before the limit. */
export async function listTaskQueuePageImpl(store: TaskStore, options: TaskQueuePageOptions): Promise<TaskListPage> {
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50) || 50));
  const order: TaskQueuePageOrder = options.order === "intake" ? "intake" : "queue";
  const columns = [...new Set(options.columns.filter((column) => typeof column === "string" && column.length > 0))];
  const layer = store.asyncLayer;
  if (!layer) throw new Error("Task pagination requires the async task backend");
  if (columns.length === 0) return { tasks: [], total: 0, hasMore: false, nextCursor: null };
  const scope = taskQueueScopeSignature(columns);
  const cursor = options.cursor ? decodeTaskQueueCursor(options.cursor, layer.projectId ?? "", order, scope) : undefined;

  const [total, rows] = await Promise.all([
    countLiveTasks(layer, { columns }),
    store.listTasks({
      columns: columns as ColumnId[],
      includeArchived: false,
      slim: true,
      // FNXC:TaskLogProjections 2026-10-10-20:01 (RUFU-615): same settlement as the board page above —
      // a lane-scoped feed reads badges from the write-time projections, not from the log column.
      excludeLog: true,
      limit: limit + 1,
      sort: order === "intake" ? "intake-desc" : "queue-order",
      startupMemo: false,
      ...(cursor
        ? order === "intake"
          ? { afterIntakeKey: { createdAt: cursor.createdAt, id: cursor.id } }
          : { afterQueueKey: { sequence: cursor.sequence, createdAt: cursor.createdAt, id: cursor.id } }
        : {}),
    }),
  ]);
  const hasMore = rows.length > limit;
  const tasks = rows.slice(0, limit);
  const last = tasks.at(-1);
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({
        v: 1,
        projectId: layer.projectId ?? "",
        order,
        scope,
        ...taskQueuePageKey(last),
      } satisfies TaskQueueCursorPayload), "utf8").toString("base64url")
    : null;
  return { tasks, total, hasMore, nextCursor };
}

export interface CompletedTaskCounts {
  byColumn: Record<string, number>;
  byWorkflow: Record<string, Record<string, number>>;
}

export interface CompletedTaskPage {
  tasks: Task[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  counts: CompletedTaskCounts;
}

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
The cursor contract version is bumped to 2 with FN-509's removal of the selectable Done sort. A v1
cursor was minted under a sort the server no longer honours, so replaying it would interleave two
different total orders and produce gaps or duplicates; rejecting it forces a clean restart at the
head instead.
*/
type CompletedCursorPayload = {
  v: 2;
  projectId: string;
  completionAt: string;
  numericSuffix: string;
  id: string;
};

function decodeCompletedCursor(cursor: string, projectId: string): CompletedCursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CompletedCursorPayload>;
    if (parsed.v !== 2 || parsed.projectId !== projectId || typeof parsed.id !== "string"
      || typeof parsed.numericSuffix !== "string" || !/^\d+$/.test(parsed.numericSuffix)
      || typeof parsed.completionAt !== "string" || Number.isNaN(Date.parse(parsed.completionAt))) {
      throw new Error("mismatch");
    }
    return parsed as CompletedCursorPayload;
  } catch {
    throw new TypeError("Invalid completed-task cursor");
  }
}

/**
 * Return a stable keyset page from every workflow completion lane, together with exact scoped counts.
 *
 * FNXC:DoneKeysetPagination 2026-09-08-22:25:
 * The opaque continuation binds project, sort mode, and the final total-order key. Clients must replay only this server cursor: deriving an offset from deduplicated or SSE-mutated rows can skip permanent history entries.
 */
export async function listCompletedTasksImpl(
  store: TaskStore,
  options?: { limit?: number; cursor?: string; slim?: boolean; compactBoardFeed?: boolean },
): Promise<CompletedTaskPage> {
  const rawLimit = options?.limit ?? 50;
  const limit = Math.min(500, Math.max(1, Math.trunc(rawLimit) || 50));
  const completeColumns = [...await resolveProjectColumnsForRoles(store, ["complete"])] as ColumnId[];
  const layer = store.asyncLayer;
  if (!layer) throw new Error("Completed-task pagination requires the async task backend");
  const projectId = layer.projectId ?? "";
  const cursor = options?.cursor ? decodeCompletedCursor(options.cursor, projectId) : undefined;
  const defaultWorkflowId = (await store.getDefaultWorkflowId()) ?? "builtin:coding";
  const result = await readCompletedTaskPage(layer, { columns: completeColumns, limit, cursor, defaultWorkflowId });
  const hasMore = result.rows.length > limit;
  const pageRows = result.rows.slice(0, limit);
  const tasks = pageRows.map((row) => store.rowToTask(store.pgRowToTaskRow(row)));
  /*
  FNXC:BoardFeedCompaction 2026-09-27-20:52 (RUFU-378):
  The Done lane is rendered by the same `TaskCard` contract as the paged board feed, so it renders
  step identity/status and never a step body. Measured live on the RunFusion board: `GET
  /api/tasks/done?limit=50` returned 2.35 MB (47 KB per card) because this path never went through
  `compactBoardFeedRow`, while `GET /api/tasks/page` already did. The same four step bodies and the
  per-column `summary` dominate the Done payload — 2.35 MB of `workflowStepResults` plus 2.26 MB of
  `summary` out of the 8.07 MB the Done lane carried in `GET /api/tasks`.

  Compaction runs on the mapped rows, after hydration, exactly as the list path does it, so derived
  badges (`computeRetrySummary` counts `priorAttempts`) are computed from the real bodies first.
  Omitted means the full shape: engine consumers that read reviewer bodies keep getting them.
  */
  if (options?.compactBoardFeed) for (const task of tasks) compactBoardFeedRow(task);
  const last = tasks.at(-1);
  const completionAt = last ? (last.columnMovedAt ?? last.updatedAt ?? last.createdAt) : undefined;
  const numericSuffix = last?.id.match(/-([0-9]+)$/)?.[1] ?? "0";
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({ v: 2, projectId, completionAt: completionAt!, numericSuffix, id: last.id } satisfies CompletedCursorPayload), "utf8").toString("base64url")
    : null;
  return { tasks, total: result.total, hasMore, nextCursor, counts: result.counts };
}

export async function listTasksModifiedSinceImpl(store: TaskStore, since: string, limit?: number, opts?: { includeArchived?: boolean },): Promise<{ tasks: Task[]; hasMore: boolean }> {
    if (Number.isNaN(Date.parse(since))) {
      throw new TypeError("listTasksModifiedSince: invalid since cursor");
    }

    const defaultLimit = 50;
    const resolvedLimit = typeof limit !== "number" || !Number.isFinite(limit)
      ? defaultLimit
      : Math.max(1, Math.min(200, Math.floor(limit)));
    const includeArchived = opts?.includeArchived ?? false;

    /*
    FNXC:SqliteFinalRemoval 2026-06-25-10:55:
    Backend-mode listTasksModifiedSince: query the PG tasks table via Drizzle
    with the same cursor pagination semantics as the SQLite path (strict
    greater-than updatedAt, ASC order, LIMIT+1 to detect hasMore). Active-task
    filtering (deleted_at IS NULL) and optional archived-column exclusion are
    applied. The result rows are converted via pgRowToTaskRow + rowToTask and
    hydrated with the same derived signals as the SQLite path.
    */
    const now = Date.now();
    const settings = await store.getSettingsFast();
    const staleThresholds: TaskAgeStalenessThresholds = {
      inProgressWarningMs: settings.staleInProgressWarningMs,
      inProgressCriticalMs: settings.staleInProgressCriticalMs,
      inReviewWarningMs: settings.staleInReviewWarningMs,
      inReviewCriticalMs: settings.staleInReviewCriticalMs,
    };
    let disableAgeStalenessHydration = false;

        const { and, asc, eq, gt, notInArray, sql } = await import("drizzle-orm");
    const schema = await import("../postgres/schema/index.js");
    const conditions = [
      sql`(${schema.project.tasks.deletedAt} IS NULL)`,
      gt(schema.project.tasks.updatedAt, since),
    ];
    if (!includeArchived) {
      /*
      FNXC:TaskArchiveRemoval 2026-09-04-18:25 DELIBERATE-LITERAL:
      This filter backs the SSE watcher and modified-since polling, so it must never publish the
      historical `archived` sentinel into the dashboard's live task list. Archive is no longer a
      workflow role; the fixed sentinel exclusion is migration compatibility, not trait resolution.
      */
      const historicalSentinels = ARCHIVED_SENTINEL_LANES;
      if (historicalSentinels && historicalSentinels.size > 0) {
        conditions.push(notInArray(schema.project.tasks.column, [...historicalSentinels]));
      } else {
        conditions.push(sql`${schema.project.tasks.column} != 'archived'`);
      }
    }
    const layer = store.asyncLayer!;
    // FNXC:MultiProjectIsolation 2026-07-10: scope the incremental-sync scan
    // (backs the SSE watcher / modified-since polling) to the bound project so
    // one project's dashboard never receives another project's task updates.
    if (layer.projectId) {
      conditions.push(eq(schema.project.tasks.projectId, layer.projectId));
    }
    const pgRows = await layer.db
      .select()
      .from(schema.project.tasks)
      .where(and(...conditions))
      .orderBy(asc(schema.project.tasks.updatedAt))
      .limit(resolvedLimit + 1);
    const hasMore = pgRows.length > resolvedLimit;
    const mergeQueuedTaskIds = await store.getMergeQueuedTaskIdsAsync();
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-28-04:00 (PR #2470 review, P1):
    Pre-resolve hold columns for the PAUSED rows only, before the synchronous
    hydration map below.

    Two constraints shape this. The map is sync, so an await cannot go inside it
    without converting a hot board-list path to Promise.all — a restructure this
    fix does not need. And `getStalePausedTodoSignal` is a no-op for a card that
    is not paused, so resolving for every row would buy nothing at real cost:
    paused cards are a small minority of a board, and the shared `irCache` means
    those few resolve one IR per workflow. A board with no paused cards does zero
    extra work.
    */
    const pageRows = pgRows.slice(0, resolvedLimit);
    const holdColumnByTaskId = new Map<string, string>();
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-29-15:20:
    The review column is pre-resolved here for the same reason the hold column is: the
    row mapping below is SYNCHRONOUS, so a per-row `await` is not available to it. Both
    share one IR cache, so a page spanning three workflows reads three IRs regardless of
    card count. Unlike hold — which only matters for a paused card — the review signals
    apply to any row, so this resolves for every row on the page.
    */
    const reviewColumnsByTaskId = new Map<string, ReadonlySet<string>>();
    /* FNXC:VerdictlessFailedGate 2026-09-14-13:32 (RUFU-217 AC4): sync row map below cannot await,
       so the gate ids the stall badge forwards ride the same precompute as the review lanes. */
    const stallGateIdsByTaskId = new Map<string, ReadonlySet<string> | undefined>();
    const lifecycleByTaskId = new Map<string, Awaited<ReturnType<typeof resolveTaskLifecycleColumns>>>();
    /*
    FNXC:WorkflowScheduling 2026-09-06 (merge origin/main dd808ed2c6):
    The selection prefetch is hoisted OUT of the lane-resolution block so the stall/bypass prelude
    below shares the one populated cache — the modified-since batching test counts exactly ONE batch
    read per pass, and a second prefetch or un-threaded hydrator would break the zero-singles rule.
    */
    const selectionCache = new Map<string, import("../workflows/workflow-ir-resolver.js").WorkflowSelection | undefined>();
    await prefetchWorkflowSelections(store, pageRows.map((row) => row.id), selectionCache);
    {
      /* FNXC:WorkflowScheduling 2026-09-05-23:12: Incremental hydration resolves multiple lanes per row, so selection prefetch prevents its former 2–3 reads per task while absent selections retain builtin:coding behavior. The one populated cache is the hoisted `selectionCache` above — a second prefetch here would re-read the batch and break the zero-singles rule that `prefetchWorkflowSelections` is asserted against. */
      const irCache = new Map<string, WorkflowIr>();
      for (const pgRow of pageRows) {
        const row = store.pgRowToTaskRow(pgRow);
        reviewColumnsByTaskId.set(row.id, await resolveReviewColumnsForTask(store, row.id, irCache, selectionCache));
        stallGateIdsByTaskId.set(row.id, await resolveStallGateIdsForTask(store, store.rowToTask(row), irCache, selectionCache));
        lifecycleByTaskId.set(row.id, await resolveTaskLifecycleColumns(store, row.id, irCache, selectionCache));
        if (store.rowToTask(row).paused !== true) continue;
        holdColumnByTaskId.set(row.id, await resolveHoldColumnForTask(store, row.id, irCache, selectionCache));
      }
    }
    /*
    FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174):
    The row map below is SYNCHRONOUS, so the stall derivation resolves here — the same precompute
    pattern `holdColumnByTaskId` established for this exact reason. This pass already resolved
    review lanes and lifecycle lanes per row above, so the derivation adds no lane re-resolves.
    Each row converts exactly ONCE: the sync map consumes the same task objects the prelude built.
    Suppressed rows (merge-queued OR fresh agent-log activity — the stalledReview rule) are skipped
    with zero resolver work, matching the helper's own suppression gate. References covered by
    this page answer from `localColumnByTaskId` with no read; a reference outside it pays one.
    */
    const stallReasonByTaskId = new Map<string, TaskStallReason | undefined>();
    // FNXC:ReviewLaneBypass 2026-09-03-13:15 (RUFU-179): same prelude pattern — the sync row map
    // below cannot await, so the capability resolves here, on its own suppression-free schedule.
    const reviewBypassByTaskId = new Map<string, ReviewBypassTarget | undefined>();
    const preludeTaskByTaskId = new Map<string, Task>();
    {
      const irCache = new Map<string, WorkflowIr>();
      const localColumnByTaskId = new Map<string, string>();
      for (const pgRow of pageRows) {
        if (typeof pgRow.id === "string" && typeof pgRow.column === "string") {
          localColumnByTaskId.set(pgRow.id, pgRow.column);
        }
      }
      for (const pgRow of pageRows) {
        const task = store.rowToTask(store.pgRowToTaskRow(pgRow));
        preludeTaskByTaskId.set(task.id, task);
        /* FNXC:ReviewLaneBypass 2026-09-03-13:15 (RUFU-179): computed BEFORE the stall-suppression
           branch below and never skipped by it — merge-queued or actively-logging cards keep their
           capability; only the store's own gates (lane, pause, gate state) decide. */
        reviewBypassByTaskId.set(task.id, await resolveReviewBypassForTask(store, task, irCache, selectionCache));
        const reviewColumnsForRow = reviewColumnsByTaskId.get(task.id) ?? new Set<string>(["in-review"]);
        if (mergeQueuedTaskIds.has(task.id) || hasFreshAgentLogActivitySinceTaskUpdate(store, task, now, reviewColumnsForRow)) {
          stallReasonByTaskId.set(task.id, undefined);
          continue;
        }
        stallReasonByTaskId.set(task.id, await hydrateTaskStallReason(store, task, {
          now,
          settings,
          suppressed: false,
          reviewColumns: reviewColumnsForRow,
          lifecycle: lifecycleByTaskId.get(task.id),
          irCache,
          selectionCache,
          localColumnByTaskId,
        }));
      }
    }
    const tasks = pageRows.map((pgRow) => {
      // FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174): the prelude above already converted
      // every page row; consume the same object so one page parses its JSON columns once.
      const task = preludeTaskByTaskId.get(pgRow.id as string) ?? store.rowToTask(store.pgRowToTaskRow(pgRow));
      const isMergeQueued = mergeQueuedTaskIds.has(task.id);
      /*
      FNXC:WorkflowLifecycle 2026-07-05-15:40:
      In-review merge/review agents stream progress to agent-log JSONL without
      necessarily mutating the task row. Treat fresh agent-log writes as active
      ownership for stall-badge hydration so the board does not show
      Stalled/Merge stalled while a merger is visibly making progress. Restores
      main's FNXC:WorkflowLifecycle 2026-07-01-23:27 behavior, which the
      PostgreSQL cutover's store split predated.
      */
      const reviewColumnsForRow = reviewColumnsByTaskId.get(task.id) ?? new Set<string>(["in-review"]);
      const hasFreshAgentLogActivity = hasFreshAgentLogActivitySinceTaskUpdate(store, task, now, reviewColumnsForRow);
      const executingTaskIds = hasFreshAgentLogActivity ? new Set<string>([task.id]) : undefined;
      task.inReviewStall = isMergeQueued ? undefined : getInReviewStallReason(task, {
        now,
        reviewColumns: reviewColumnsForRow,
        requiredPreMergeStepIds: stallGateIdsByTaskId.get(task.id),
        executingTaskIds,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.stalePausedReview = getStalePausedReviewSignal(task, {
        now,
        thresholdMs: settings.stalePausedReviewThresholdMs,
        reviewColumns: reviewColumnsForRow,
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      } satisfies StalePausedReviewContext);
      task.inReviewStalled = isMergeQueued ? undefined : getInReviewStalledSignal(task, {
        now,
        executingTaskIds,
        reviewColumns: reviewColumnsForRow,
        thresholdMs: settings.inReviewStalledThresholdMs,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      } satisfies InReviewStalledContext);
      task.stalePausedTodo = getStalePausedTodoSignal(task, {
        now,
        thresholdMs: settings.stalePausedTodoThresholdMs,
        holdColumn: holdColumnByTaskId.get(task.id),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      if (!disableAgeStalenessHydration) {
        try {
          task.ageStaleness = getTaskAgeStalenessSignal(task, {
            now,
            thresholds: staleThresholds,
            /*
            FNXC:WorkflowLifecycleColumns 2026-07-30-09:00 (fleet — the omitted sibling site):
            THE MODIFIED-SINCE PASS NEEDS THE LANES TOO. #2746 threaded `lifecycle` into the list
            pass above and left this one on the defaults, so a renamed board still produced no
            age-staleness badge for any card arriving through the incremental refresh — which is the
            path a live board actually uses after first load.

            This is the third occurrence of one specific mistake in this one file: the helper gains a
            resolved-role parameter and one of the two hydration sites is missed. The notes above
            record it for `holdColumn` (PR #2470) and then for `reviewColumn` ("same defect, same
            file, one role over"). Pinned now by reads-age-staleness-lane-hydration.test.ts, which
            asserts BOTH sites pass it rather than trusting the next reader to notice.
            */
            lifecycle: lifecycleByTaskId.get(task.id),
            engineActiveSinceMs: settings.engineActiveSinceMs,
            engineActivationGraceMs: settings.engineActivationGraceMs,
          });
        } catch (error) {
          if (error instanceof RangeError) {
            disableAgeStalenessHydration = true;
            storeLog.warn("Invalid stale task thresholds; skipping age staleness hydration for this modified-since pass", {
              error: error.message,
            });
          } else {
            throw error;
          }
        }
      }
      task.timedExecutionMs = store.computeTimedExecutionMs(task.log);
      task.stalledReview = isMergeQueued || hasFreshAgentLogActivity ? undefined : detectStalledReview(task, { now, reviewColumns: reviewColumnsForRow });
      task.retrySummary = computeRetrySummary(task);
      // FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174): board-feed parity — resolved in the
      // async prelude above, attached without extra reads because this map is synchronous.
      task.stallReason = stallReasonByTaskId.get(task.id);
      // FNXC:ReviewLaneBypass 2026-09-03-13:15 (RUFU-179): attached from the prelude map — parity
      // with the stall sites above, minus any suppression.
      task.reviewBypass = reviewBypassByTaskId.get(task.id);
      task.log = [];
      return task;
    });
    return { tasks, hasMore };
}

async function hydrateSearchTaskRows(
  store: TaskStore,
  pgRows: Record<string, unknown>[],
  slim: boolean,
  compactBoardFeed: boolean,
): Promise<Task[]> {
const now = Date.now();
const settings = await store.getSettingsFast();
const mergeQueuedTaskIds = await store.getMergeQueuedTaskIdsAsync();
// Shared across the page so one workflow is read once, not once per hit.
const searchPassIrCache = new Map<string, WorkflowIr>();
/* FNXC:WorkflowScheduling 2026-09-05-23:12: Search hydration has the same per-row selection N+1 as board lists; prefetch retains the default workflow for cached absent selections. */
const searchPassSelectionCache = new Map<string, import("../workflows/workflow-ir-resolver.js").WorkflowSelection | undefined>();
await prefetchWorkflowSelections(store, pgRows.map((row) => String(row.id)), searchPassSelectionCache);
await prefetchWorkflowIrs(store, pgRows.map((row) => String(row.id)), searchPassIrCache, searchPassSelectionCache);
  return Promise.all(pgRows.map(async (pgRow) => {
  const task = store.rowToTask(store.pgRowToTaskRow(pgRow));
  const isMergeQueued = mergeQueuedTaskIds.has(task.id);
  /*
  FNXC:WorkflowLifecycle 2026-07-05-15:40:
  In-review merge/review agents stream progress to agent-log JSONL without
  necessarily mutating the task row. Treat fresh agent-log writes as active
  ownership for stall-badge hydration so the board does not show
  Stalled/Merge stalled while a merger is visibly making progress. Restores
  main's FNXC:WorkflowLifecycle 2026-07-01-23:27 behavior, which the
  PostgreSQL cutover's store split predated.
  */
  /* FNXC:WorkflowLifecycleColumns 2026-07-31-01:20 (fleet): resolved ONCE for this row — it was
     resolved inline twice below, and the fresh-activity gate could not see it at all. */
  const reviewColumnsForRow = await resolveReviewColumnsForTask(store, task.id, searchPassIrCache, searchPassSelectionCache);
  const hasFreshAgentLogActivity = hasFreshAgentLogActivitySinceTaskUpdate(store, task, now, reviewColumnsForRow);
  const executingTaskIds = hasFreshAgentLogActivity ? new Set<string>([task.id]) : undefined;
  task.inReviewStall = isMergeQueued ? undefined : getInReviewStallReason(task, {
    now,
    reviewColumns: reviewColumnsForRow,
    requiredPreMergeStepIds: isMergeQueued ? undefined : await resolveStallGateIdsForTask(store, task, searchPassIrCache, searchPassSelectionCache),
    executingTaskIds,
    autoMerge: allowsAutoMergeProcessing(task, settings),
    engineActiveSinceMs: settings.engineActiveSinceMs,
    engineActivationGraceMs: settings.engineActivationGraceMs,
  });
  task.inReviewStalled = isMergeQueued ? undefined : getInReviewStalledSignal(task, {
    now,
    executingTaskIds,
    reviewColumns: reviewColumnsForRow,
    thresholdMs: settings.inReviewStalledThresholdMs,
    autoMerge: allowsAutoMergeProcessing(task, settings),
    engineActiveSinceMs: settings.engineActiveSinceMs,
    engineActivationGraceMs: settings.engineActivationGraceMs,
  } satisfies InReviewStalledContext);
  task.stalledReview = isMergeQueued || hasFreshAgentLogActivity ? undefined : detectStalledReview(task, { now, reviewColumns: reviewColumnsForRow });
  task.retrySummary = computeRetrySummary(task);
  if (slim) {
    task.timedExecutionMs = store.computeTimedExecutionMs(task.log);
    task.log = [];
  }
  // FNXC:BoardFeedCompaction 2026-09-17-14:49: same post-derivation drop as the board lane path.
  if (compactBoardFeed) compactBoardFeedRow(task);
  if (task.steps.length > 0) {
    return task;
  }
  // FNXC:TaskDetailPromptResilience 2026-07-10-16:00 (merge port from main):
  // an unreadable PROMPT.md must not reject this Promise.all and 500 the
  // entire search — degrade to the persisted (empty) steps and log.
  try {
    const steps = await store.parseStepsFromPrompt(task.id);
    return steps.length > 0 ? { ...task, steps } : task;
  } catch (err) {
    // FNXC:ListReadPromptParseCache 2026-10-02-11:59 (RUFU-495): a malformed PROMPT.md stays malformed, so this
    // warning used to repeat on every read of the same card (~1.7 lines/s on the production board). Same
    // signal, once per card.
    const detail = `failed to sync steps from PROMPT.md for ${task.id} during searchTasks: ${err instanceof Error ? err.message : String(err)}`;
    if (shouldWarnPromptParseFailure(store, task.id, detail)) storeLog.warn(`[task-detail] ${detail}`);
    return task;
  }
}));

}

export async function searchTasksImpl(store: TaskStore, query: string, options?: { limit?: number; offset?: number; slim?: boolean; includeArchived?: boolean }): Promise<Task[]> {
    // FNXC:RuntimePersistenceAsync 2026-06-24-11:00:
    // Backend-mode searchTasks delegates live rows to the generated tsvector
    // index and composes cold-storage matches when requested.
        const trimmedQuery = query?.trim();
    if (!trimmedQuery) {
      return store.listTasks(options);
    }
    const layer = store.asyncLayer!;
    const limit = options?.limit;
    const offset = options?.offset ?? 0;
    if (limit !== undefined && Math.max(0, limit) === 0) return [];
    const includeArchived = options?.includeArchived ?? false;
    const slim = options?.slim ?? false;
    // The tsvector path is the primary search (GIN-backed). The LIKE path is
    // a fallback if the tsvector query returns no results (e.g., if the search
    // index is cold).
    const mergedPrefixLimit = includeArchived && limit !== undefined
      ? Math.max(0, offset) + Math.max(0, limit)
      : undefined;
    const sourceLimit = includeArchived ? mergedPrefixLimit : limit;
    const sourceOffset = includeArchived ? 0 : offset;
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
    Live search excludes the stable historical sentinel and soft-deleted rows. Internal forensic
    reads may explicitly compose cold snapshots, but no workflow archive role participates.
    */
    const searchHistoricalSentinels = ARCHIVED_SENTINEL_LANES;
    let pgRows = await searchTasksTsvector(layer.db, trimmedQuery, {
      limit: sourceLimit,
      offset: sourceOffset,
      includeArchived,
      archivedColumns: searchHistoricalSentinels,
      // FNXC:MultiProjectIsolation 2026-07-10: scope search to the bound project
      // (load-bearing for the CREATE-time near-duplicate check via searchTasks).
      projectId: layer.projectId,
    });
    if (pgRows.length === 0) {
      pgRows = await searchTasksLike(layer.db, trimmedQuery, {
        limit: sourceLimit,
        offset: sourceOffset,
        includeArchived,
        archivedColumns: searchHistoricalSentinels,
        projectId: layer.projectId,
      });
    }
    const now = Date.now();
    const settings = await store.getSettingsFast();
    const mergeQueuedTaskIds = await store.getMergeQueuedTaskIdsAsync();
    // Shared across the page so one workflow is read once, not once per hit.
    const searchPassIrCache = new Map<string, WorkflowIr>();
    /* FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174): the stall resolver answers references
       covered by this search page from its own rows (raw rows, so no JSON parse), paying at most
       one indexed read for a reference outside the page. */
    const searchLocalColumns = new Map<string, string>();
    for (const pgRow of pgRows) {
      if (typeof pgRow.id === "string" && typeof pgRow.column === "string") {
        searchLocalColumns.set(pgRow.id, pgRow.column);
      }
    }
    /* FNXC:WorkflowScheduling 2026-09-05-23:12: Search hydration has the same per-row selection N+1 as board lists; prefetch retains the default workflow for cached absent selections. */
    const searchPassSelectionCache = new Map<string, import("../workflows/workflow-ir-resolver.js").WorkflowSelection | undefined>();
    await prefetchWorkflowSelections(store, pgRows.map((row) => String(row.id)), searchPassSelectionCache);
    /* FNXC:WorkflowScheduling 2026-09-05-23:12 (ported by merge origin/main f59f9ead92 -> main, 2026-09-09):
       upstream warms the IR cache once per search pass beside the selection prefetch. This stays the fork's
       inline hydrator because it is the only copy that carries RUFU-174 `stallReason` and RUFU-179
       `reviewBypass` parity; upstream's extracted `hydrateSearchTaskRows` does not. */
    await prefetchWorkflowIrs(store, pgRows.map((row) => String(row.id)), searchPassIrCache, searchPassSelectionCache);
    const tasks = await Promise.all(pgRows.map(async (pgRow) => {
      const task = store.rowToTask(store.pgRowToTaskRow(pgRow));
      const isMergeQueued = mergeQueuedTaskIds.has(task.id);
      /*
      FNXC:WorkflowLifecycle 2026-07-05-15:40:
      In-review merge/review agents stream progress to agent-log JSONL without
      necessarily mutating the task row. Treat fresh agent-log writes as active
      ownership for stall-badge hydration so the board does not show
      Stalled/Merge stalled while a merger is visibly making progress. Restores
      main's FNXC:WorkflowLifecycle 2026-07-01-23:27 behavior, which the
      PostgreSQL cutover's store split predated.
      */
      /* FNXC:WorkflowLifecycleColumns 2026-07-31-01:20 (fleet): resolved ONCE for this row — it was
         resolved inline twice below, and the fresh-activity gate could not see it at all. */
      const reviewColumnsForRow = await resolveReviewColumnsForTask(store, task.id, searchPassIrCache, searchPassSelectionCache);
      // FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174): one struct build on the shared cache,
      // consumed by the stall derivation below (search never had a lifecycle need of its own).
      const rowLifecycle = await resolveTaskLifecycleColumns(store, task.id, searchPassIrCache, searchPassSelectionCache);
      const hasFreshAgentLogActivity = hasFreshAgentLogActivitySinceTaskUpdate(store, task, now, reviewColumnsForRow);
      const executingTaskIds = hasFreshAgentLogActivity ? new Set<string>([task.id]) : undefined;
      task.inReviewStall = isMergeQueued ? undefined : getInReviewStallReason(task, {
        now,
        reviewColumns: reviewColumnsForRow,
        requiredPreMergeStepIds: isMergeQueued ? undefined : await resolveStallGateIdsForTask(store, task, searchPassIrCache, searchPassSelectionCache),
        executingTaskIds,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.inReviewStalled = isMergeQueued ? undefined : getInReviewStalledSignal(task, {
        now,
        executingTaskIds,
        reviewColumns: reviewColumnsForRow,
        thresholdMs: settings.inReviewStalledThresholdMs,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      } satisfies InReviewStalledContext);
      task.stalledReview = isMergeQueued || hasFreshAgentLogActivity ? undefined : detectStalledReview(task, { now, reviewColumns: reviewColumnsForRow });
      task.retrySummary = computeRetrySummary(task);
      /* FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174): parity with the board/detail feeds — the
         search hits carry the same reason the operator sees on the card. Archived matches merged
         below are cold-storage snapshots and stay terminal-by-construction (no reason). */
      task.stallReason = await hydrateTaskStallReason(store, task, {
        now,
        settings,
        suppressed: isMergeQueued || hasFreshAgentLogActivity,
        reviewColumns: reviewColumnsForRow,
        lifecycle: rowLifecycle,
        irCache: searchPassIrCache,
        selectionCache: searchPassSelectionCache,
        localColumnByTaskId: searchLocalColumns,
      });
      /* FNXC:ReviewLaneBypass 2026-09-03-13:15 (RUFU-179): search parity — a card reached through
         search offers exactly what the board and detail views offer. Search rows are full selects,
         and the slim strip below only zeroes `log`, so results are real here too. */
      task.reviewBypass = await resolveReviewBypassForTask(store, task, searchPassIrCache, searchPassSelectionCache);
      if (slim) {
        task.timedExecutionMs = store.computeTimedExecutionMs(task.log);
        task.log = [];
      }
      if (task.steps.length > 0) {
        return task;
      }
      // FNXC:TaskDetailPromptResilience 2026-07-10-16:00 (merge port from main):
      // an unreadable PROMPT.md must not reject this Promise.all and 500 the
      // entire search — degrade to the persisted (empty) steps and log.
      try {
        const steps = await store.parseStepsFromPrompt(task.id);
        return steps.length > 0 ? { ...task, steps } : task;
      } catch (err) {
        // FNXC:ListReadPromptParseCache 2026-10-02-11:59 (RUFU-495): a malformed PROMPT.md stays malformed, so this
        // warning used to repeat on every read of the same card (~1.7 lines/s on the production board). Same
        // signal, once per card.
        const detail = `failed to sync steps from PROMPT.md for ${task.id} during searchTasks: ${err instanceof Error ? err.message : String(err)}`;
        if (shouldWarnPromptParseFailure(store, task.id, detail)) storeLog.warn(`[task-detail] ${detail}`);
        return task;
      }
    }));
    if (!includeArchived) return tasks;
    /*
    FNXC:PostgresArchiveReads 2026-07-14-17:09:
    Search pagination is global across live and archived matches. Query both project-scoped sources without per-source offsets, keep the established live-then-archive ordering, deduplicate by task id, then apply the requested page.
    */
    /*
    FNXC:PostgresArchiveReadPerformance 2026-07-14-17:50:
    Search preserves its live-results-first contract. For a finite page only the first offset+limit live matches can contribute; cold matches are fetched in bounded chunks until deduplication against authoritative live IDs fills the requested prefix or cold storage is exhausted.
    */
    const target = mergedPrefixLimit;
    const archiveEntries: ArchivedTaskEntry[] = [];
    if (target === undefined || tasks.length < target) {
      const chunkSize = target === undefined ? undefined : Math.max(1, target - tasks.length);
      let archiveOffset = 0;
      while (true) {
        const chunk = await searchArchivedTasks(layer.db, trimmedQuery, chunkSize, layer.projectId, archiveOffset);
        archiveEntries.push(...chunk);
        if (chunkSize === undefined || chunk.length < chunkSize) break;
        const uniqueCount = mergePrimaryById(tasks, archiveEntries.map((entry) => store.archiveEntryToTask(entry, slim))).length;
        if (target !== undefined && uniqueCount >= target) break;
        archiveOffset += chunk.length;
      }
    }
    const matches = mergePrimaryById(tasks, archiveEntries.map((entry) => store.archiveEntryToTask(entry, slim)));
    if (limit === undefined) return matches.slice(offset);
    return matches.slice(offset, offset + Math.max(0, limit));
}

/* FNXC:TaskVerificationRequest 2026-07-30-00:00: status reads are project-scoped so chat never observes another project's request. */
export async function getTaskVerificationRequestAsyncImpl(store: TaskStore, taskId: string): Promise<TaskVerificationRequest | null> {
  /*
  FNXC:SqliteDualPathCleanup 2026-07-26-13:30:
  PostgreSQL is the only runtime authority; the former non-backend early-return null path is gone.
  */
  const layer = store.asyncLayer!;
  const projectFilter = layer.projectId ? eq(schema.project.taskVerificationRequests.projectId, layer.projectId) : undefined;
  const rows = await layer.db.select().from(schema.project.taskVerificationRequests).where(and(eq(schema.project.taskVerificationRequests.taskId, taskId), ...(projectFilter ? [projectFilter] : []))).limit(1);
  const row = rows[0];
  return row ? { taskId: row.taskId, requestId: row.requestId, status: row.status as TaskVerificationStatus, profile: row.profile as TaskVerificationRequest["profile"], command: row.command, scope: row.scope as TaskVerificationRequest["scope"], requestedBy: row.requestedBy, requestedAt: row.requestedAt, ...(row.startedAt ? { startedAt: row.startedAt } : {}), ...(row.completedAt ? { completedAt: row.completedAt } : {}), ...(row.result ? { result: row.result as TaskVerificationResultSummary } : {}), ...(row.rejectionReason ? { rejectionReason: row.rejectionReason } : {}) } : null;
}

/**
 * FNXC:TaskRecommendations 2026-08-13-04:41:
 * Insights needs a dedicated narrow read because its aggregate is advisory triage and must remain
 * bounded. Rows, rather than JSONB items, are paged with updatedAt/id ordering so equal completion
 * timestamps cannot drop or duplicate a row; offset paging is sufficient because creating a task
 * links the recommendation without removing its source row.
 */
export async function listTaskRecommendationsImpl(
  store: TaskStore,
  options?: { completeColumns?: ReadonlySet<string>; limit?: number; offset?: number },
): Promise<TaskRecommendationListPage> {
  const layer = store.asyncLayer!;
  const completeColumns = options?.completeColumns ?? await resolveProjectColumnsForRoles(store, ["complete"]);
  const rawLimit = options?.limit;
  const rawOffset = options?.offset;
  const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.trunc(rawLimit))) : 50;
  const offset = typeof rawOffset === "number" && Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  const columns = [...completeColumns];
  const liveFilter = columns.length === 0 ? undefined : and(
    taskProjectScope(layer),
    isNull(schema.project.tasks.deletedAt),
    inArray(schema.project.tasks.column, columns),
    isNotNull(schema.project.tasks.recommendations),
    sql`jsonb_array_length(${schema.project.tasks.recommendations}) > 0`,
  );
  /*
  FNXC:ArchivedRecommendations 2026-09-20-17:23:
  Cold entries are terminal recommendation sources too. Merge physical archive snapshots with live
  complete-role rows; a plain deleted row is intentionally absent because it has no snapshot.
  */
  const [liveRows, archivedEntries] = await Promise.all([
    liveFilter
      ? layer.db.select({ id: schema.project.tasks.id, title: schema.project.tasks.title, column: schema.project.tasks.column, updatedAt: schema.project.tasks.updatedAt, recommendations: schema.project.tasks.recommendations })
        .from(schema.project.tasks).where(liveFilter).orderBy(desc(schema.project.tasks.updatedAt), desc(schema.project.tasks.id))
      : Promise.resolve([]),
    listArchivedTaskEntries(layer.db, layer.projectId),
  ]);
  const rows = [
    ...liveRows.map((row) => ({
      id: row.id,
      title: row.title ?? undefined,
      column: row.column,
      updatedAt: row.updatedAt,
      recommendations: Array.isArray(row.recommendations) ? row.recommendations as TaskRecommendation[] : [],
    })),
    ...archivedEntries
      .filter((entry) => Array.isArray(entry.recommendations) && entry.recommendations.length > 0)
      .map((entry) => ({ id: entry.id, title: entry.title, column: "archived", updatedAt: entry.updatedAt, recommendations: entry.recommendations! })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
  const page = rows.slice(offset, offset + limit);
  const items: TaskRecommendationListItem[] = [];
  for (const row of page) {
    for (const recommendation of row.recommendations) {
      items.push({ taskId: row.id, taskTitle: row.title, taskColumn: row.column as TaskRecommendationListItem["taskColumn"], updatedAt: row.updatedAt, recommendation: recommendation as TaskRecommendation });
    }
  }
  const totalRowCount = rows.length;
  const returnedRowCount = page.length;
  return { items, rowOffset: offset, rowLimit: limit, returnedRowCount, totalRowCount, hasMore: offset + returnedRowCount < totalRowCount };
}
