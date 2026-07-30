/*
FNXC:WorkflowLifecycleColumns 2026-07-31-19:30:
The PROJECT's lane vocabulary — the columns to READ before there is a task to resolve from.

WHY THIS EXISTS. Every lane guard so far resolves from a task: `resolveTaskLifecycleColumns(store, id)`
answers "what does THIS card's workflow call its review lane". That is the right shape for a guard,
and the wrong shape for a QUERY, because a query runs before any task is in hand:

    await store.listTasks({ column: "in-review" })   // ← nothing to resolve from

`#2800` measured the cost: `self-healing.ts` alone issues 49 such reads, and on a board whose lanes
are renamed every one returns an EMPTY array, so the sweep it feeds never executes. The census scores
the comparison inside the loop, not the query above it, so converting those comparisons drops a count
and changes nothing an operator can observe — the loop body was already unreachable.

Fixing a query needs a different answer: not "this task's lane" but "every column ANY workflow in this
project declares for this role". That is what this module returns, and it is deliberately shared
rather than re-derived per call site — I wrote this logic once inline for the legacy auto-merge stamp
backfill, and a second copy is how two readers of the same fact start disagreeing.

THE LEGACY ID IS UNIONED, NOT REPLACED. A board mid-rename still has rows stored under the old id, and
a query that skips them silently does nothing — which is the exact failure being fixed. Over-inclusion
costs one extra query whose rows are then filtered by the caller's own predicate; under-inclusion is
invisible. Those are not symmetric.

WHAT THIS IS NOT. It does not tell you what a given CARD's lane is — use `resolveTaskLifecycleColumns`
for that. Answering a per-card question from this union would mark a card as review because some other
workflow calls its column review, which is the flat-set mistake this program has already made four
times.
*/

import { columnsWithFlag } from "./workflow-lifecycle-traits.js";
import { parseWorkflowIr } from "./workflow-ir.js";
import type { TraitFlags } from "./trait-types.js";

/** The store surface this needs — deliberately narrow so callers can pass a fake. */
export interface ProjectLaneVocabularyStore {
  listWorkflowDefinitions: () => Promise<ReadonlyArray<{ ir?: unknown }>>;
}

/**
 * Legacy column ids per role, unioned into every answer.
 *
 * NOT lifecycle rules — the ids the built-in board shipped with, kept so a project mid-rename (rows
 * still stored under the old id) is never skipped by a query.
 */
export const LEGACY_COLUMN_IDS_BY_ROLE: Record<string, readonly string[]> = {
  intake: ["todo", "triage"],
  hold: ["todo"],
  countsTowardWip: ["in-progress"],
  mergeOrchestration: ["in-review"],
  mergeBlocker: ["in-review"],
  humanReview: ["in-review"],
  complete: ["done"],
  archived: ["archived"],
};

/**
 * Every column id any workflow in this project declares for the given trait roles, unioned with the
 * legacy ids for those roles.
 *
 * @param roles one or more trait flags — pass several to get a union (e.g. the three review traits).
 * @returns a set safe to iterate as `listTasks({ column })` reads. Never empty: the legacy ids are
 *          always present, so a caller cannot accidentally query nothing.
 */
export async function resolveProjectColumnsForRoles(
  store: ProjectLaneVocabularyStore,
  roles: ReadonlyArray<keyof TraitFlags & string>,
): Promise<ReadonlySet<string>> {
  const columns = new Set<string>();
  for (const role of roles) {
    for (const legacy of LEGACY_COLUMN_IDS_BY_ROLE[role] ?? []) columns.add(legacy);
  }

  let definitions: ReadonlyArray<{ ir?: unknown }> = [];
  try {
    definitions = await store.listWorkflowDefinitions();
  } catch {
    /*
    An unreadable definition LIST leaves the legacy ids alone — the behaviour a caller had before it
    adopted this helper. Throwing here would turn a degraded workflow read into a failed sweep, which
    is strictly worse than a sweep covering only the built-in lanes.
    */
    return columns;
  }

  for (const definition of definitions) {
    /*
    PER-DEFINITION isolation, and the reason is measured rather than defensive: `parseWorkflowIr`
    VALIDATES (it throws on a graph without exactly one start and one end), so a single malformed or
    half-migrated row would otherwise abort the whole loop and silently hand back legacy-only lanes
    for every OTHER workflow too. One bad row must not erase the project's vocabulary — that failure
    would look exactly like the renamed-board bug this helper exists to fix.

    My first draft wrapped the entire loop in one `try`, and the string-IR test is what exposed it.
    */
    try {
      const ir = typeof definition.ir === "string" ? parseWorkflowIr(definition.ir) : definition.ir;
      if (!ir) continue;
      for (const role of roles) {
        for (const id of columnsWithFlag(ir as never, role)) columns.add(id);
      }
    } catch {
      continue;
    }
  }

  return columns;
}

/** The three traits that all mean "a card is in review"; see `isReviewColumnRole` for why it is a union. */
export const REVIEW_ROLES = ["mergeOrchestration", "mergeBlocker", "humanReview"] as const;

/** "Finished either way" — the pair `resolveTerminalColumns` answers for a single task. */
export const TERMINAL_ROLES = ["complete", "archived"] as const;
