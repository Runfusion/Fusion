import {
  HIGH_FANOUT_BLOCKER_TODO_THRESHOLD,
  STALE_HIGH_FANOUT_BLOCKER_AGE_THRESHOLD_MS,
  type Task,
} from "../types.js";

export interface BlockerEscalation {
  blockerId: string;
  activeTodoCount: number;
  totalActiveCount: number;
  blockingAgeMs: number;
}

export interface BlockerFanoutEntry {
  totalCount: number;
  activeTodoCount: number;
  dependentIds: string[];
  dependencyDependentIds: string[];
  overlapBlockedDependentIds: string[];
  overlapBlockedActiveCount: number;
  overlapBlockedTodoCount: number;
  staleBlockedByDependentIds: string[];
  isHighFanout: boolean;
  escalation?: BlockerEscalation;
}

export interface ComputeBlockerFanoutOptions {
  nowMs?: number;
  highFanoutTodoThreshold?: number;
  staleHighFanoutAgeThresholdMs?: number;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-27-21:50 (Phase B / U6):
  The workflow's completion columns. "Active" is defined by
  exclusion — not complete — which is what the concept always
  meant; the old `ACTIVE_COLUMNS` enumeration was a default-workflow-shaped
  stand-in that silently scored 0 active dependents for every column a custom
  workflow adds. Under-counting, not erroring: a blocker with real blocked
  dependents looked unblocking, and no test failed.
  Defaults to the built-in `{done}` completion lane when workflow metadata is unavailable.
  */
  terminalColumns?: ReadonlySet<string>;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-10:00 (PR #2749 review — greptile P1):
  The board's REVIEW lane, the set-shaped twin of `terminalColumns`.

  Without it, the set-shaped path (the one the ONLY production caller actually takes) could resolve
  "is this blocker terminal?" but still asked "is it in review?" with the literal — so a renamed
  paused or retry-exhausted review blocker stayed classified as active and its dependents stayed
  displayed and prioritised as blocked. A converted predicate reachable only through an option
  nobody passes is the guard-that-cannot-fire pattern; this is what makes it fire.

  Defaults to the legacy `{in-review}` so unconverted callers are unchanged.
  */
  reviewColumns?: ReadonlySet<string>;
  /** The workflow's HOLD (capacity-wait) column. The fan-out metric counts cards
   *  waiting for capacity, which is the hold role — `todo` is only the id the
   *  built-in coding workflow gives it. Defaults to `"todo"`. */
  holdColumn?: string;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-28-17:50 (PR #2479 review, P1):
  PER-TASK classification, and the only correct option on a multi-workflow board.

  The set-shaped options above are board-wide, which silently assumes a column id
  means the same thing everywhere. It does not: an id is meaningful only RELATIVE
  TO ITS OWN WORKFLOW. When two workflows reuse an id for different roles — one
  calling `done` its hold column, another calling `done` terminal — any union of
  those sets marks that column BOTH held and terminal, and every card in it is
  misclassified regardless of which workflow it belongs to.

  Supplying `classify` resolves each task against its own workflow, which makes
  that misclassification impossible by construction. It takes precedence over
  `terminalColumns`/`holdColumn`; those remain for single-vocabulary callers
  (task-priority's unblock weighting) and as the legacy default.
  */
  classify?: (task: Task) => { isHold: boolean; isTerminal: boolean };
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-05:00 (batch-core feed):
  The lanes an ACTIVE blocker can occupy for escalation purposes — wip ∪ review.

  This one was invisible to the census: the gate is a membership test against the exported
  `BLOCKER_ESCALATION_COLUMNS` Set, and a Set literal is a DEFINITION, not a comparison, so nothing
  in the backlog ever pointed here. The three converted options above sat directly beside a
  hard-coded one.

  Consequence on a renamed board: `shouldEscalate` was false for every blocker, so a stale blocker
  holding up many cards NEVER escalated. No escalation looks exactly like nothing needing escalation
  — the fan-out metric itself stayed correct, which makes it worse: the numbers say there is a
  problem and the mechanism that acts on them is switched off.

  Defaults to `BLOCKER_ESCALATION_COLUMNS` so unconverted callers are byte-identical.
  */
  escalationColumns?: ReadonlySet<string>;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-18:00:
  PER-TASK escalation, and it takes precedence over the flat set above.

  Added by applying a rule I had just written for myself on another review: *if a caveat describes a
  wrong answer the code can actually produce, it is a bug with good documentation, not a documented
  trade-off.* I shipped `escalationColumns` as a board-wide union with a note saying it
  over-approximates on a multi-workflow board — which is a wrong answer, just a cheap one: a blocker
  can be labelled `long-lived` because ANOTHER workflow calls its column active.

  Same reasoning and same shape as `classify` above, which this module already documents as the only
  correct option when a board spans workflows. The flat set stays for single-vocabulary callers and
  as the legacy default.
  */
  escalationClassify?: (task: Task) => boolean;
}

export const BLOCKER_ESCALATION_COLUMNS = new Set<Task["column"]>(["in-progress", "in-review"]);

/** Legacy default: the built-in coding workflow's terminal columns. Retained as
 *  the fallback so an un-resolved caller keeps byte-identical behavior (R11). */


interface MutableEntry {
  dependentIds: string[];
  dependencyDependentIds: string[];
  blockedByDependentIds: string[];
  activeCount: number;
  activeTodoCount: number;
  overlapBlockedActiveCount: number;
  overlapBlockedTodoCount: number;
}

/*
FNXC:WorkflowLifecycleColumns 2026-08-02-17:35 (fleet: the pure lifecycle predicates):
"IS THIS BLOCKER STALE?" — i.e. may the blocked card stop waiting on it. Three lifecycle questions in four
lines: the blocker is finished, or it is parked in review, or it is a review row that exhausted its merge
retries. All three were the default lineage's ids.

On a renamed board every one answered NO, so a blocked card kept waiting on a blocker that was done, paused
in review, or permanently failed — waiting forever, with no signal, because "not stale" is the silent answer.

Injected rather than resolved: this module is pure and its callers already hold the blocker row. The optional
set defaults to the legacy ids so no existing caller changes behaviour.
*/
export function isStaleBlockedByBlocker(
  blocker: Task | undefined,
  maxAutoMergeRetries: number,
  lanes?: { terminal?: ReadonlySet<string>; review?: ReadonlySet<string> },
): boolean {
  if (!blocker) return true;
  const terminal = lanes?.terminal ?? LEGACY_TERMINAL_COLUMNS;
  const review = lanes?.review ?? LEGACY_REVIEW_COLUMNS;
  if (terminal.has(blocker.column)) return true;
  if (review.has(blocker.column) && blocker.paused === true) return true;
  if (review.has(blocker.column) && blocker.status === "failed" && (blocker.mergeRetries ?? 0) >= maxAutoMergeRetries) {
    return true;
  }
  return false;
}

/** The ids from before workflows owned the vocabulary; the fallback when a caller supplies no lanes. */
const LEGACY_TERMINAL_COLUMNS: ReadonlySet<string> = new Set(["done"]);
const LEGACY_REVIEW_COLUMNS: ReadonlySet<string> = new Set(["in-review"]);

function getBlockingAgeMs(blocker: Task, nowMs: number): number {
  const startedAt = Date.parse(blocker.columnMovedAt ?? blocker.updatedAt);
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, nowMs - startedAt);
}

export function computeBlockerFanoutMap(
  tasks: Task[],
  maxAutoMergeRetries: number,
  options: ComputeBlockerFanoutOptions = {},
): Map<string, BlockerFanoutEntry> {
  const nowMs = options.nowMs ?? Date.now();
  const highFanoutTodoThreshold =
    options.highFanoutTodoThreshold ?? HIGH_FANOUT_BLOCKER_TODO_THRESHOLD;
  const staleHighFanoutAgeThresholdMs =
    options.staleHighFanoutAgeThresholdMs ?? STALE_HIGH_FANOUT_BLOCKER_AGE_THRESHOLD_MS;

  const terminalColumns = options.terminalColumns ?? LEGACY_TERMINAL_COLUMNS;
  /* DELIBERATE-LITERAL — the unconverted-caller default, reviewed 2026-07-31-05:00. */
  const escalationColumns = options.escalationColumns ?? BLOCKER_ESCALATION_COLUMNS;
  /* Per-task wins over the board-wide set, which wins over the legacy default. */
  const isEscalationLane = (task: Task | undefined): boolean =>
    task !== undefined
    && (options.escalationClassify ? options.escalationClassify(task) : escalationColumns.has(task.column));
  const holdColumn = options.holdColumn ?? "todo";
  const reviewColumns = options.reviewColumns ?? LEGACY_REVIEW_COLUMNS;

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const fanout = new Map<string, MutableEntry>();

  const ensureEntry = (blockerId: string): MutableEntry => {
    let entry = fanout.get(blockerId);
    if (!entry) {
      entry = {
        dependentIds: [],
        dependencyDependentIds: [],
        blockedByDependentIds: [],
        activeCount: 0,
        activeTodoCount: 0,
        overlapBlockedActiveCount: 0,
        overlapBlockedTodoCount: 0,
      };
      fanout.set(blockerId, entry);
    }
    return entry;
  };

  for (const task of tasks) {
    /*
    Per-task classification wins when supplied (PR #2479 P1); otherwise fall back
    to the board-wide set / single hold column. Active is by EXCLUSION — not
    terminal — never by enumeration.
    */
    const roles = options.classify?.(task);
    const active = roles ? !roles.isTerminal : !terminalColumns.has(task.column);
    const isTodo = roles ? roles.isHold : task.column === holdColumn;

    for (const depId of task.dependencies ?? []) {
      if (!depId) continue;
      const entry = ensureEntry(depId);
      entry.dependentIds.push(task.id);
      entry.dependencyDependentIds.push(task.id);
      if (active) entry.activeCount += 1;
      if (isTodo) entry.activeTodoCount += 1;
    }

    if (task.blockedBy) {
      const entry = ensureEntry(task.blockedBy);
      entry.dependentIds.push(task.id);
      entry.blockedByDependentIds.push(task.id);
      if (active) {
        entry.activeCount += 1;
        entry.overlapBlockedActiveCount += 1;
      }
      if (isTodo) {
        entry.activeTodoCount += 1;
        entry.overlapBlockedTodoCount += 1;
      }
    }
  }

  const result = new Map<string, BlockerFanoutEntry>();
  for (const [blockerId, entry] of fanout) {
    const blocker = taskById.get(blockerId);
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-21:40 (rebased onto #2745):
    THREAD THE LANES INTO THE PREDICATE. #2745 gave `isStaleBlockedByBlocker` an optional `lanes`
    argument and left THIS — its only production call — passing none, so the converted predicate ran
    on the legacy defaults and behaviour was unchanged while the census scored the conversion as
    done. That is the half-conversion this program keeps re-finding, one layer down.

    `classify` is preferred for the terminal question because it answers per TASK against the task's
    own workflow, which is the shape the notes above establish for this function. It does not answer
    the REVIEW lane at all (`isTerminal`/`isHold` only), so the resolved sets are handed to the
    predicate as well — otherwise the paused / retry-exhausted halves of staleness stay on literals
    on every path, including the set-shaped one the sole production caller takes.
    */
    const blockerRoles = blocker ? options.classify?.(blocker) : undefined;
    const blockerIsTerminal = blockerRoles
      ? blockerRoles.isTerminal
      : blocker !== undefined && terminalColumns.has(blocker.column);
    const staleBlockedByDependentIds = (
      !blocker
      || blockerIsTerminal
      || isStaleBlockedByBlocker(blocker, maxAutoMergeRetries, {
        terminal: terminalColumns,
        review: reviewColumns,
      })
    )
      ? [...entry.blockedByDependentIds]
      : [];

    const isHighFanout = entry.overlapBlockedTodoCount >= highFanoutTodoThreshold;
    const blockingAgeMs = blocker ? getBlockingAgeMs(blocker, nowMs) : 0;
    const blockerColumn = blocker?.column;
    const shouldEscalate =
      blockerColumn !== undefined &&
      isHighFanout &&
      isEscalationLane(blocker) &&
      blockingAgeMs >= staleHighFanoutAgeThresholdMs;

    result.set(blockerId, {
      totalCount: entry.activeCount,
      activeTodoCount: entry.activeTodoCount,
      dependentIds: entry.dependentIds,
      dependencyDependentIds: entry.dependencyDependentIds,
      overlapBlockedDependentIds: entry.blockedByDependentIds,
      overlapBlockedActiveCount: entry.overlapBlockedActiveCount,
      overlapBlockedTodoCount: entry.overlapBlockedTodoCount,
      staleBlockedByDependentIds,
      isHighFanout,
      escalation: shouldEscalate
        ? {
            blockerId,
            activeTodoCount: entry.overlapBlockedTodoCount,
            totalActiveCount: entry.overlapBlockedActiveCount,
            blockingAgeMs,
          }
        : undefined,
    });
  }

  return result;
}
