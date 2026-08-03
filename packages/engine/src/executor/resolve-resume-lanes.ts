/**
 * FNXC:CodeOrganization 2026-08-03-13:25:
 * resolveResumeLanes peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-16:00:
 * Resume-safe columns (hold/wip/review) resolved from the task workflow, not default literals.
 * Memoized per recovery so eligibility and re-entry share one snapshot.
 */
import type { TaskStore } from "@fusion/core";
import { resolveLifecycleColumns, resolveWorkflowIrForTask } from "@fusion/core";
import { declaresAnyLifecycleRole } from "./lifecycle-columns.js";

export type ResumeLanes = { hold: string; wip: string; review: string; wipDeclared: boolean };

export type ResolveResumeLanesDeps = {
  store: TaskStore;
};

export async function resolveResumeLanes(
  deps: ResolveResumeLanesDeps,
  taskId: string,
  memo?: { lanes?: ResumeLanes },
): Promise<ResumeLanes> {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (PR #2640 review, greptile P2):
    ONE RESOLUTION PER RECOVERY, and the reason is correctness as much as I/O. Eligibility and
    re-entry ran this separately, so a workflow edit landing between the two calls would have the
    two halves of one decision reading DIFFERENT lane sets — the eligibility check admits a card in
    review, the re-entry then resolves a board where that column is not the review lane. The memo is
    caller-owned and per-recovery, which is the same shape as the IR caches elsewhere in the engine:
    one snapshot for one decision, never a process-lifetime cache that has to guess when a
    mid-flight workflow edit invalidates it.
    */
    if (memo?.lanes) return memo.lanes;
    try {
      const lifecycle = resolveLifecycleColumns(await resolveWorkflowIrForTask(deps.store, taskId));
      const lanes = {
        hold: lifecycle?.hold ?? "todo",
        wip: lifecycle?.wip ?? "in-progress",
        review: lifecycle?.review ?? "in-review",
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-30-15:30 (PR #2760 review — greptile P1):
        Whether the resolved IR actually DECLARES an implementation lane, which the `?? "in-progress"`
        default above destroys. Callers that must not act without a real implementation lane read this
        instead of comparing against the default.

        THREE states, not two, and conflating the last two is a regression:
          a. wip declared                        -> true
          b. lifecycle lanes declared, wip NOT   -> FALSE; the workflow genuinely has no implementation
                                                   lane, so there is nowhere to resume TO
          c. NO lifecycle lane declared at all   -> true; this is a v1 workflow upgraded in place. Its
                                                   synthesized columns carry `traits: []`, so
                                                   `resolveLifecycleColumns` returns `{}` — measured, not
                                                   assumed — and treating that as "no wip lane" would
                                                   terminalize every legacy custom workflow's
                                                   graph-failure recovery instead of resuming it.

        The discriminator is whether the IR expresses lifecycle intent AT ALL. An untraited legacy board
        expresses none, so the legacy trio is the honest answer and today's behaviour is preserved.
        */
        wipDeclared: lifecycle?.wip !== undefined || !declaresAnyLifecycleRole(lifecycle),
      };
      if (memo) memo.lanes = lanes;
      return lanes;
    } catch {
      // IR unavailable: we cannot know, so keep the legacy board's assumption and today's behaviour.
      const lanes = { hold: "todo", wip: "in-progress", review: "in-review", wipDeclared: true };
      if (memo) memo.lanes = lanes;
      return lanes;
    }
}
