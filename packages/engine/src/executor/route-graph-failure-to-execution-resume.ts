/**
 * FNXC:CodeOrganization 2026-08-03-13:25:
 * routeGraphFailureToExecutionResume peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowLifecycle 2026-06-29-11:08:
 * Graph failures with unfinished work rebound to todo for execution resume, not review.
 *
 * FNXC:HonestBlockedExit 2026-08-02-23:59:
 * Durable task-dependency BLOCKED parks skip resume bounce.
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-21:40:
 * Resume-router gate uses resolved lanes, not default-lineage literals.
 *
 * FNXC:WorkflowRemediation 2026-08-09-21:41:
 * FN-8910: completed work + policy-refused remediation stays parked in review.
 */
import type { TaskDetail, TaskStore } from "@fusion/core";
import { COMPLETION_SUMMARY_NODE_ID } from "@fusion/core";
import { isDurableBlockedTask } from "../execution-block-classifier.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { resolveReboundColumnFor, resolveTerminalColumnsFor } from "./lifecycle-columns.js";
import { hasNonTerminalWorkflowSteps } from "./workflow-step-satisfaction.js";
import { isMergeGraphFailure } from "./graph-failure-pure.js";
import type { ResumeLanes } from "./resolve-resume-lanes.js";

export type RouteGraphFailureToExecutionResumeDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  resolveResumeLanes: (
    taskId: string,
    memo?: { lanes?: ResumeLanes },
  ) => Promise<ResumeLanes>;
  clearTerminalStepFailuresForRetry: (taskId: string) => Promise<void>;
  persistTokenUsage: (taskId: string) => Promise<void>;
  /**
   * FNXC:WorkflowRemediation 2026-08-09-21:41:
   * Detects fire-and-forget remediation / plan-replan nodes (IR action + built-in ids).
   */
  isRemediationGraphNode: (taskId: string, failedNode: string | undefined) => Promise<boolean>;
};

export async function routeGraphFailureToExecutionResume(
  deps: RouteGraphFailureToExecutionResumeDeps,
  live: TaskDetail,
  failedNode: string,
  failureValue: string | undefined,
  resumeLanesMemo?: { lanes?: ResumeLanes },
): Promise<boolean> {
    /*
     * FNXC:WorkflowLifecycle 2026-06-29-11:08:
     * A workflow graph failure is not a completion handoff. FN-7228/FN-7229 showed
     * restart-time parse failures and incomplete steps being parked in `in-review`
     * with errors, which blocks the engine from resuming the correct unfinished
     * step. Keep executable work in the executable queue: clear graph failure
     * markers and move review-column rows with unfinished work back to `todo`
     * preserving step progress. Generic graph failures that remain in-progress
     * are left failed in-place by the caller; they must never be handed to review.
     */
    if (live.deletedAt) return false;
    if (live.paused || live.userPaused === true) return false;
    if ((await resolveTerminalColumnsFor(deps.store, live.id)).includes(live.column)) return false;
    /*
    FNXC:HonestBlockedExit 2026-08-02-23:59:
    Durable external (task-dependency) BLOCKED parks must NOT bounce to todo for execution
    resume — the scheduler requeues them when the blocking tasks complete. PR/file-claim
    parks and the session-log BLOCKED promotion are removed (operator decision, FN-8728):
    open PRs are never blockers, so only metadata-classed task-dependency parks are honored.
    */
    if (isDurableBlockedTask(live)) {
      executorLog.log(
        `${live.id}: graph failure resume skipped — durable BLOCKED park honored (task-dependency block)`,
      );
      return false;
    }
    /*
     * FNXC:WorkflowCompletion 2026-07-01-16:26:
     * Backstop for issue #1863. The advisory completion-summary node must never
     * drive the in-review→todo resume loop: it has no failure edge, so a failure
     * here would bounce the task back to execution every run and never stick.
     * The graph executor now degrades summary-node failures to success, so this
     * should be unreachable — but if a summary failure ever reaches this router,
     * let the caller park the task `failed` (a visible terminal state) instead of
     * looping it forever.
     */
    if (failedNode === COMPLETION_SUMMARY_NODE_ID) return false;
    const incompleteSteps = hasNonTerminalWorkflowSteps(live);
    /*
     * FNXC:WorkflowRemediation 2026-08-09-21:41:
     * FN-8910: fire-and-forget remediation nodes have no failure edge. A policy
     * or budget refusal after implementation is complete must park visibly in
     * the resolved review lane, not clear blockers and eject the card to planning.
     * IR workflowAction detection keeps custom renamed remediation nodes covered.
     */
    if (!incompleteSteps
      && (failureValue === "remediation-not-scheduled" || failureValue === "missing-remediation-context")
      && await deps.isRemediationGraphNode(live.id, failedNode)) return false;
    const implementationIncompleteMergeFailure = isMergeGraphFailure(failedNode) && failureValue === "implementation-incomplete";
    if (implementationIncompleteMergeFailure && !incompleteSteps) return false;
    const prematureMergeWithIncompleteSteps = implementationIncompleteMergeFailure && incompleteSteps;
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet: executor.ts — the REVERSE half-conversion):
    THE DESTINATION WAS ALREADY RESOLVED HERE AND THE GATE WAS NOT. `resolveReboundColumnFor` below picks
    the board's rebound column (U7), but this gate compared against three default-lineage literals — so on
    a renamed board the router refused before ever reaching the resolved move. That is the mirror image of
    the dangerous half-conversion: instead of admitting a card and sending it nowhere, it refuses a card
    whose recovery was fully implemented, and nothing is logged as wrong. Same one-decision-two-boards
    defect, opposite direction, and the silent one.
    */
    const resumeRouterLanes = await deps.resolveResumeLanes(live.id, resumeLanesMemo);
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-14:20:
    A workflow that declares NO implementation lane has nowhere to resume TO, so this router must not
    claim the card — the graph failure has to reach the terminalize branch and be visible.

    Without this, a card resting in such a workflow's HOLD lane with incomplete steps matched the
    second arm above (`incompleteSteps && live.column === lanes.hold`), the router rehomed it and
    returned true, and the failure was swallowed: `status` and `error` both stayed null. The operator
    saw a card that had silently stopped. That is the exact shape the sibling branch below already
    guards with `wipColumn !== undefined` before claiming a card "already advanced"; this is the same
    fail-closed rule on the opposite path, which was failing OPEN.
    */
    if (!resumeRouterLanes.wipDeclared) return false;
    if (live.column !== resumeRouterLanes.review
      && !(incompleteSteps && live.column === resumeRouterLanes.hold)
      && !(prematureMergeWithIncompleteSteps && live.column === resumeRouterLanes.wip)) return false;

    const message = incompleteSteps
      ? `Workflow graph failed at node '${failedNode}'${failureValue ? ` (${failureValue})` : ""} with incomplete steps — moved back to todo for execution resume`
      : `Workflow graph failed at node '${failedNode}'${failureValue ? ` (${failureValue})` : ""} before a clean review handoff — moved back to todo for workflow retry`;
    executorLog.warn(`${live.id}: ${message}`);
    await deps.store.logEntry(live.id, message, undefined, deps.getRunContextFor(live.id));
    await deps.store.updateTask(live.id, {
      status: null,
      error: null,
    }, deps.getRunContextFor(live.id));
    const reboundColumn = await resolveReboundColumnFor(deps.store, live.id);
    if (live.column !== reboundColumn) {
      await deps.store.moveTask(live.id, reboundColumn, {
        preserveProgress: true,
        moveSource: "engine",
        recoveryRehome: true,
      });
    }
    // FNXC:ReviewLeniency 2026-07-02-02:10: clear prior terminal failure results
    // (incl. optional gate nodes like code-review) AFTER the task is in `todo`
    // (non-mergeable) so the resumed run re-evaluates gates from a clean slate
    // without dropping the in-review merge blocker mid-flight. (in-review→todo
    // moveTask already clears all results; this covers the already-`todo` path.)
    await deps.clearTerminalStepFailuresForRetry(live.id);
    await deps.persistTokenUsage(live.id);
    return true;
}
