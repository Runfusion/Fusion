import { useMemo } from "react";
import { type Task } from "@fusion/core";
import {
  computeBlockerFanoutMap as computeBlockerFanoutMapCore,
  type BlockerFanoutEntry,
} from "../../../core/src/tasks/blocker-fanout";

export type { BlockerFanoutEntry };

// Keep in sync with packages/engine/src/self-healing.ts default export.
// FNXC:AutoMergeRetries 2026-06-17-04:20: Dashboard fanout copy uses this as a display fallback until task-card surfaces receive live project settings; engine/self-healing decisions use resolveMaxAutoMergeRetries(settings) and are authoritative.
export const MAX_AUTO_MERGE_RETRIES = 3;

/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:10 (dashboard fan-out read the LEGACY board):
The per-task trait index, the same shape `App.tsx` already builds for the footer
(`footerColumnFlagsByTaskId`): a task's own workflow, then that workflow's entry for the column the
card rests in.

Until this existed the dashboard wrapper called core with NO lane answers, so every blocker-fanout
surface classified against `todo` / `in-review` / `done`. Core defines "active" by EXCLUSION — not
terminal — so on a renamed board a FINISHED card in (say) `shipped` was never terminal and stayed an
active blocker forever: the Executor bar's highest-overlap blocker and the task modal's blocking-
dependents list both kept naming work that had already landed.

PER TASK rather than a board-wide union, for the reason `blocker-fanout.ts` documents on `classify`:
an id means something only relative to its OWN workflow, and this board renders several at once.
Optional — omitted, core keeps its legacy defaults, so an unconverted caller is byte-identical.
*/
export interface BlockerFanoutColumnFlags {
  readonly complete?: boolean;
  readonly hold?: boolean;
  readonly countsTowardWip?: boolean;
  readonly mergeOrchestration?: boolean;
  readonly mergeBlocker?: boolean;
  readonly humanReview?: boolean;
}

export interface UseBlockerFanoutOptions {
  staleHighFanoutAgeThresholdMs?: number;
  columnFlagsByTaskId?: ReadonlyMap<string, BlockerFanoutColumnFlags>;
}

/** Review is the union of the three review roles — the answer every converted reader gives. */
function isReviewRole(flags: BlockerFanoutColumnFlags): boolean {
  return flags.mergeOrchestration === true || flags.mergeBlocker === true || flags.humanReview === true;
}

/*
Escalation is wip ∪ review, mirroring `scheduler.ts`'s own construction exactly. The two must agree:
the scheduler decides that a blocker escalates and the dashboard is where an operator sees it.
*/
function isEscalationRole(flags: BlockerFanoutColumnFlags): boolean {
  return flags.countsTowardWip === true || isReviewRole(flags);
}

/*
DELIBERATE-LITERAL — the unresolved-card fallback, reviewed 2026-07-30-23:40.

Hoisted into named helpers rather than written inline for two reasons: the census reads markers from
a declaration's leading comments (an inline one attaches to the wrong node and is silently ignored),
and this is a documented degraded mode that deserves a name.

Reached only for a card the board could not resolve traits for — the pre-load window, or a stranded
card resting in a column its workflow no longer declares. Fabricating a role there would be worse
than the legacy answer: it would invent lifecycle state the operator never configured. These are the
same literals `blocker-fanout.ts` uses for its own unconverted-caller defaults, so an unresolved card
behaves exactly as it did before this seam existed.
*/
function legacyIsHold(column: string): boolean {
  return column === "todo";
}

/* DELIBERATE-LITERAL — the terminal half of the same unresolved-card fallback. */
function legacyIsTerminal(column: string): boolean {
  return column === "done";
}

/* DELIBERATE-LITERAL — the escalation half of the same unresolved-card fallback. */
function legacyIsEscalation(column: string): boolean {
  return column === "in-progress" || column === "in-review";
}

export function computeBlockerFanoutMap(
  tasks: Task[],
  options: UseBlockerFanoutOptions = {},
): Map<string, BlockerFanoutEntry> {
  const flagsByTaskId = options.columnFlagsByTaskId;
  return computeBlockerFanoutMapCore(tasks, MAX_AUTO_MERGE_RETRIES, {
    staleHighFanoutAgeThresholdMs: options.staleHighFanoutAgeThresholdMs,
    /*
    Only supplied when the board actually resolved traits. An EMPTY map is not "no card is terminal";
    it is the pre-load window and the remote-node case, where fabricating answers would be worse than
    the documented legacy default.
    */
    ...(flagsByTaskId && flagsByTaskId.size > 0
      ? {
        classify: (task: Task) => {
          const flags = flagsByTaskId.get(task.id);
          /* A card whose traits did not resolve keeps the legacy answer rather than a fabricated one. */
          if (!flags) return { isHold: legacyIsHold(task.column), isTerminal: legacyIsTerminal(task.column) };
          return { isHold: flags.hold === true, isTerminal: flags.complete === true };
        },
        escalationClassify: (task: Task) => {
          const flags = flagsByTaskId.get(task.id);
          if (!flags) return legacyIsEscalation(task.column);
          return isEscalationRole(flags);
        },
        reviewColumns: new Set(
          tasks.filter((task) => {
            const flags = flagsByTaskId.get(task.id);
            return flags !== undefined && isReviewRole(flags);
          }).map((task) => task.column),
        ),
      }
      : {}),
  });
}

export function useBlockerFanout(
  tasks: Task[],
  options: UseBlockerFanoutOptions = {},
): Map<string, BlockerFanoutEntry> {
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:45:
  `columnFlagsByTaskId` MUST be a dependency, or the whole seam is inert on the board.

  The board builds its trait index from `boardWorkflows`, which is null until an async fetch
  resolves — so the FIRST computation always runs against an empty map and takes the documented
  legacy fallback. When the index populates, neither `tasks` nor the threshold has changed, so a
  memo keyed on those two never recomputes and the pre-load answer survives for the life of the
  mount. Threaded end to end, correctly typed, and never arriving.

  This repo has no `react-hooks/exhaustive-deps` rule, so a stale dep array here is invisible to
  lint and a disable directive for that rule fails CI. The list is maintained by hand.
  */
  return useMemo(
    () => computeBlockerFanoutMap(tasks, options),
    [tasks, options.staleHighFanoutAgeThresholdMs, options.columnFlagsByTaskId],
  );
}
