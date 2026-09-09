/*
FNXC:WorkflowLifecycleColumns 2026-07-31-19:30:
The PROJECT's lane vocabulary — the columns to READ before there is a task to resolve from.

WHY THIS EXISTS. Every lane guard so far resolves from a task: `resolveTaskLifecycleColumns(store, id)`
answers "what does THIS card's workflow call its review lane". That is the right shape for a guard,
and the wrong shape for a QUERY, because a query runs before any task is in hand:

    await store.listTasks({ column: "in-review" })   // ← nothing to resolve from

`#2800` measured the cost: `self-healing.ts` alone issued 49 such reads, and on a board whose lanes
are renamed every one returns an EMPTY array, so the sweep it feeds never executes. The census scores
the comparison inside the loop, not the query above it, so converting those comparisons drops a count
and changes nothing an operator can observe — the loop body was already unreachable.

That 49 is a MEASUREMENT WITH A DATE, not a constant: it was 37 at the time of writing and falls as
the fleet converts them. Reproduce rather than trust it —
`node scripts/lifecycle-column-census.mjs --json` reports `queryByFile` and `queryRoles`. Quoting a
hand-counted figure with no way to regenerate it is how a note starts lying about another file, which
this program has now corrected twice in comments that were true when written.

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

import { columnsWithFlag, declaresAnyLifecycleTrait } from "./workflows/workflow-lifecycle-traits.js";
import { parseWorkflowIr } from "./workflows/workflow-ir.js";
import type { TraitFlags } from "./workflows/trait-types.js";

/** The store surface this needs — deliberately narrow so callers can pass a fake. */
export interface ProjectLaneVocabularyStore {
  /*
  FNXC:WorkflowLifecycleColumns 2026-08-01-03:10:
  OPTIONAL, because several call sites hold a deliberately narrow store interface that does not
  declare this method even though the real `TaskStore` behind it has one (`EvalBatchTaskStore` is the
  first such caller). Requiring it would force every narrow interface to widen — a contract change
  rippling into their fakes — to satisfy a helper whose whole contract is "degrade to the legacy ids
  when the workflows cannot be read".

  Absent method and throwing method are therefore the same case, and both are already covered.
  */
  listWorkflowDefinitions?: () => Promise<ReadonlyArray<{ ir?: unknown }>>;
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
};

/**
 * Every column id any workflow in this project declares for the given trait roles, unioned with the
 * legacy ids for those roles.
 *
 * @param roles one or more trait flags — pass several to get a union (e.g. the three review traits).
 * @returns a set safe to iterate as `listTasks({ column })` reads. Never empty: the legacy ids are
 *          always present, so a caller cannot accidentally query nothing.
 */
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-20:30:
THE UNTRAITED-PROJECT OPT-IN — the three-state rule at PROJECT scope, and why it cannot be a default.

This helper seeds the legacy ids and adds whatever workflows DECLARE for the role. A board that renames
its lanes but declares NO lifecycle trait on any column therefore contributes nothing, so its cards are
invisible to every query keyed on a role — the card is not in the result at all, and a correct per-card
fallback downstream never runs for it. Recorded at three self-healing call sites (#2869, #2876).

`untraitedProject: "declared-columns"` widens the answer for exactly that case: when NO workflow in the
project expresses ANY lifecycle trait, every declared column id joins the set. Not "no workflow declares
THIS role" — a board that expresses traits and simply has no review lane has ANSWERED, and widening
there would invent lanes it deliberately does not have.

WHY IT IS OPT-IN AND NOT THE DEFAULT. The safe direction differs by caller, which is the whole finding
of `docs/solutions/workflow-learnings/project-union-versus-per-task-lanes.md`:
  - a SWEEP over-includes harmlessly — the per-card check downstream discards the extra rows, and the
    cost is a few wasted `listTasks` calls;
  - an AGGREGATOR does not — the same widening inflates a number an operator reads (#2864, #2866);
  - an ACTION site does not — over-inclusion means a card routed or notified under a vocabulary that is
    not its own (#2852, #2891).
Making this the default would silently change all three at once, in the one direction two of them must
not move. So it changes nothing until a caller asks for it, and each caller asks for its own reasons.
*/
export interface ProjectLaneResolutionOptions {
  /** Widen to every declared column when the project expresses no lifecycle trait at all. */
  untraitedProject?: "declared-columns";
}

export async function resolveProjectColumnsForRoles(
  store: ProjectLaneVocabularyStore,
  roles: ReadonlyArray<keyof TraitFlags & string>,
  options: ProjectLaneResolutionOptions = {},
): Promise<ReadonlySet<string>> {
  const columns = new Set<string>();
  /* Collected while walking the definitions so the widening needs no second read. */
  const declaredColumnIds = new Set<string>();
  let anyTraitExpressed = false;
  for (const role of roles) {
    for (const legacy of LEGACY_COLUMN_IDS_BY_ROLE[role] ?? []) columns.add(legacy);
  }

  let definitions: ReadonlyArray<{ ir?: unknown }> = [];
  if (typeof store.listWorkflowDefinitions !== "function") return columns;
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
      if (options.untraitedProject === "declared-columns") {
        for (const column of (ir as { columns?: { id?: string }[] }).columns ?? []) {
          if (typeof column?.id === "string") declaredColumnIds.add(column.id);
        }
        if (declaresAnyLifecycleTrait(ir as never)) anyTraitExpressed = true;
      }
    } catch {
      continue;
    }
  }

  /*
  Only when the project as a WHOLE expressed nothing. A single traited workflow means the project has a
  vocabulary, and a board inside it that declares no lifecycle trait is that board's own omission — not
  something to paper over by admitting every column in the project.
  */
  if (options.untraitedProject === "declared-columns" && !anyTraitExpressed) {
    for (const id of declaredColumnIds) columns.add(id);
  }

  return columns;
}

/** The three traits that all mean "a card is in review"; see `isReviewColumnRole` for why it is a union. */
export const REVIEW_ROLES = ["mergeOrchestration", "mergeBlocker", "humanReview"] as const;

/** The terminal-success role used for project-wide completed-task reads. */
export const TERMINAL_ROLES = ["complete"] as const;

/*
FNXC:TaskArchiveRemoval 2026-09-04-10:36:
`"archived"` is no longer a workflow lane or lifecycle role. It remains a stable return sentinel for
`getLiveTaskColumn` when a parent is soft-deleted, so document and artifact publication gates retain
one immutable vocabulary without consulting workflow definitions.
*/
export const ARCHIVED_SENTINEL_LANES: ReadonlySet<string> = new Set(["archived"]);
