/**
 * FNXC:CodeOrganization 2026-08-03-12:50:
 * Workflow lifecycle column resolvers peeled from executor.ts (U4 Slice A pure helpers).
 * Fail-soft to legacy ids; re-exported from executor.ts for callers/tests that import the facade.
 *
 * FNXC:WorkflowLifecycleTraits 2026-07-19-09:10 (U5b / KTD-10 / KTD-1):
 * Every executor "requeue to backlog for retry/resume" rebound targets the task's
 * TRAIT-derived backlog column (resolveReboundTarget: hold → intake → first), not the
 * literal "todo". builtin:coding resolves to `todo` so the default pipeline is
 * byte-identical; a custom/renamed workflow lands its recovered card in a valid
 * backlog column. These are the KTD-1 RECOVERABLE rebounds (they preserve progress /
 * resume state); the KTD-1 exhaustion parks (FN-8141 blocked, retry-exhausted) set
 * status:"failed" in place WITHOUT a move and are intentionally untouched here.
 * One IR resolution per rebound (a recovery path, not an enumeration loop); any
 * resolution failure falls back to the legacy "todo" so a rebound is never stranded.
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-15:10 (Phase C convergence):
 * THE "ALREADY THERE?" GUARDS NOW COMPARE AGAINST THIS RESULT. Eight call sites read
 * X.column !== "todo" before moving to the resolved column — so on a renamed board the
 * guard was ALWAYS true and the engine issued a move into the column the card was already
 * in. That is a real move: moveTaskInternal runs the reset-on-entry effects again. At the
 * preserveProgress: false site (stale workflow parse pins) it reset step progress a second
 * time on a card that had only been re-checked, and every site re-ran the status/error/pause
 * clears. The move TARGET was converted here in U5b; the guards in front of it were not,
 * which is the half-conversion shape: the correct target reached through a check that could
 * not see it. Each site now resolves once and uses the same value for both.
 */
import type { TaskStore, WorkflowSelectionCache } from "@fusion/core";
import {
  resolveCompleteColumn,
  resolveLifecycleColumns,
  resolveReboundTarget,
  resolveTerminalColumns,
  resolveWorkflowIrForTask,
} from "@fusion/core";

/**
 * The task's completion column, fail-soft to the legacy id. Mirrors
 * `resolveReboundColumnFor` below: one IR resolution on a rare guard path, and a
 * resolution failure must keep today's behaviour rather than answer "not terminal".
 */
/** The terminal ids from before workflows owned the vocabulary. */
export const LEGACY_TERMINAL_COLUMNS: readonly string[] = ["done"];

/*
FNXC:WorkflowResolvedColumns 2026-07-30-19:10 (exported for the follow-up dedup paths):
EXPORTED rather than copied. `eval-followups.ts` and `pr-comment-handler.ts` each carried their own
Closed-followup guards use this resolver for the same question, and a third
and fourth copy of the union-with-legacy reasoning is exactly the drift this program exists to remove.
Nothing else about the function changes.
*/
export async function resolveTerminalColumnsFor(
  store: TaskStore,
  taskId: string,
  /*
  FNXC:WorkflowLifecycleColumns 2026-08-12-00:20:
  Optional caller-owned IR and selection caches let sweeps read one IR per workflow and one
  selection per task. Single-task callers pass neither and retain the original behavior.
  */
  irCache?: Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>,
  selectionCache?: WorkflowSelectionCache,
): Promise<readonly string[]> {
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (PR #2568 review — greptile):
  THE UNION IS DELIBERATE, and the `catch` alone was not enough.

  `resolveWorkflowIrForTask` does NOT throw when a custom workflow definition is
  missing, corrupt or unavailable — it returns the BUILT-IN IR. So the catch below
  only covers hard failures, while the common degraded case hands back a
  valid-looking default whose terminals are `done`/`archived`. A renamed board in
  that state would resolve terminals that do not include its own terminal column,
  and this guard would go inert exactly as it did before the conversion.

  Unioning with the legacy pair closes that: a resolvable board contributes its real
  terminals, and the legacy ids remain recognised whether they came from a genuine
  default workflow or from a silent substitution.

  Over-inclusion is the SAFE direction here, and that is why a union is acceptable
  rather than sloppy. This guard answers "is the card already finished, so skip
  parking?" — being too inclusive occasionally skips parking a card that was not
  really terminal; being too exclusive MOVES a finished card out of its terminal
  column, which is the failure the conversion exists to prevent.
  */
  try {
    const resolved = resolveTerminalColumns(await resolveWorkflowIrForTask(store, taskId, irCache, selectionCache));
    return [...new Set([...resolved, ...LEGACY_TERMINAL_COLUMNS])];
  } catch {
    return LEGACY_TERMINAL_COLUMNS;
  }
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-15:20 (fleet — executor.ts cluster):
The workflow's COMPLETE column, for the guards that ask "has this card finished?" and mean
completion specifically. `resolveTerminalColumnsFor` above returns the same workflow completion role for membership guards.

Same shape as the two helpers beside it: resolve from the task's own workflow, fall back to
the legacy id. `resolveWorkflowIrForTask` does not throw on a missing definition — it returns
the built-in default — so the catch covers hard failures only.
*/
export async function resolveCompleteColumnFor(store: TaskStore, taskId: string): Promise<string> {
  try {
    return resolveCompleteColumn(await resolveWorkflowIrForTask(store, taskId)) ?? "done";
  } catch {
    return "done";
  }
}

export async function resolveReboundColumnFor(store: TaskStore, taskId: string): Promise<string> {
  try {
    return resolveReboundTarget(await resolveWorkflowIrForTask(store, taskId)) ?? "todo";
  } catch {
    return "todo";
  }
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-18:10 (tightening my own rule against #2765):
Does this IR express ANY lifecycle intent? #2765 published the general form of the distinction I hit
in the no-wip fix: an empty role result means either DECLARED AND EMPTY (a v2 board the operator
wrote that genuinely lacks the lane — a guard should act on it) or SYNTHESIZED (a v1 graph upgraded
in place; `synthesizeDefaultColumns` emits `{ id, name: id, traits: [] }` for the five default ids,
so every role resolves undefined even though those columns ARE the legacy lanes).

My first discriminator proxied this with "hold and review are both undefined". That is right for the
boards under test and wrong in general: a v2 workflow declaring, say, intake and complete but no
hold/wip/review would read as SYNTHESIZED and the resume router would proceed into a wip lane the
board does not have — the same failure the guard exists to stop, one case narrower.

`resolveLifecycleColumns` returns all six roles, so the honest question is whether ANY of them
resolved. Checking two of six was a proxy for that; this checks the thing.
*/
export function declaresAnyLifecycleRole(lifecycle: ReturnType<typeof resolveLifecycleColumns>): boolean {
  if (!lifecycle) return false;
  return Object.values(lifecycle).some((columnId) => columnId !== undefined);
}
