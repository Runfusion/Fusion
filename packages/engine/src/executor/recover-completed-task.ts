/**
 * FNXC:CodeOrganization 2026-08-03-10:50:
 * recoverCompletedTask peeled from TaskExecutor (U4).
 * Shared auto-promotion chokepoint: completed work → in-review (or graph re-entry).
 */
import { existsSync } from "node:fs";
import type { Task, TaskStore } from "@fusion/core";
import {
  evaluateCompletedPromotionFailureProvenance,
  evaluateSkipBypassTaint,
  isFastExecutionMode,
} from "@fusion/core";
import { resolvePlannerLanesForTaskAsync } from "../execution/replan-target.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { resolveAuthoritativeExternalExecutionRoute } from "./resolve-authoritative-external-execution-route.js";
import { isTaskWorkComplete } from "./task-predicates.js";
import { areEnabledPreMergeWorkflowStepsSatisfied } from "./workflow-step-satisfaction.js";

export type RecoverCompletedTaskDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  executing: Set<string>;
  activeSessions: { has(taskId: string): boolean };
  activeStepExecutors: { has(taskId: string): boolean };
  activeWorkflowStepSessions: { has(taskId: string): boolean };
  resumingUnpaused: Set<string>;
  processWideGraphRouting: Set<string>;
  workflowRerunWatchdogs: { has(taskId: string): boolean };
  workflowRerunPending: { has(taskId: string): boolean };
  recoveringCompleted: Set<string>;
  captureModifiedFiles: (
    worktree: string,
    baseCommitSha: string | null | undefined,
    taskId: string,
    audit: undefined,
    source: string,
  ) => Promise<string[]>;
  shouldDeferCompletionForGlobalPause: (taskId: string, context: string) => Promise<boolean>;
  executeWorkflowGraph: (task: Task) => Promise<unknown>;
  clearCompletedTaskWatchdog: (taskId: string) => void;
  persistTokenUsage: (taskId: string) => Promise<void>;
  handoffTaskToReview: (task: Task, reason: string) => Promise<unknown>;
  signalTaskComplete: (task: Task) => void;
};

export async function recoverCompletedTask(
  deps: RecoverCompletedTaskDeps,
  task: Task,
): Promise<boolean> {
  try {
    if (
      deps.executing.has(task.id)
      || deps.activeSessions.has(task.id)
      || deps.activeStepExecutors.has(task.id)
      || deps.activeWorkflowStepSessions.has(task.id)
      || deps.resumingUnpaused.has(task.id)
      || deps.processWideGraphRouting.has(task.id)
    ) {
      executorLog.debug(`${task.id}: skipping recoverCompletedTask — task has active execution in flight`);
      return false;
    }

    /*
    FNXC:WorkflowOptionalStepFix 2026-06-28-12:00:
    A pre-merge optional/advisory step REVISE (Code Review / Browser Verification) reopens
    plan steps to `pending` and schedules a remediation bounce (sendTaskBackForFix →
    scheduleWorkflowRerun) that moves the task directly from review to WIP so the executor
    can finish the reopened steps without an intermediate Planning stop. Re-entering the workflow graph here while that bounce is
    still scheduled — or while the live task already carries incomplete plan steps — preempts
    the executor's single fix cycle: the re-run re-passes the advisory step (its fix budget is
    now exhausted), advances to the `merge` node, and the merge gate refuses with
    "task has incomplete steps" forever (observed on FN-7210; the FN-7122 bounce fix handled
    the column race but not this competing graph re-entry). recoverCompletedTask only owns
    tasks whose work is genuinely COMPLETE, so refuse re-entry when a remediation bounce is in
    flight or the live task has non-terminal steps, and let the bounce / stale-incomplete-review
    recovery re-launch execution instead.
    */
    if (deps.workflowRerunWatchdogs.has(task.id) || deps.workflowRerunPending.has(task.id)) {
      executorLog.debug(`${task.id}: skipping recoverCompletedTask — workflow remediation bounce already scheduled`);
      return false;
    }
    const liveForCompletenessCheck = await deps.store.getTask(task.id).catch(() => task);
    if (
      liveForCompletenessCheck
      && (liveForCompletenessCheck.steps?.length ?? 0) > 0
      && !isTaskWorkComplete(liveForCompletenessCheck)
    ) {
      executorLog.debug(`${task.id}: skipping recoverCompletedTask — task has incomplete steps awaiting executor remediation`);
      return false;
    }
    /*
    FNXC:Lifecycle 2026-07-16-21:40:
    FN-8141 — recoverCompletedTask is the shared auto-promotion chokepoint for every
    "work looks complete → in-review" path (unpause resume, completed-task watchdog,
    orphan resume). Refuse to auto-promote a skip-bypass-tainted task: its steps were
    skipped after a bulk-step-completion refusal with no accepted fn_task_done, so the
    only honest exits are an accepted fn_task_done or operator intervention (both clear
    the taint). Leaving it unpromoted lets the bounded requeue/park machinery converge
    it to a human instead of laundering it to review.
    */
    if (liveForCompletenessCheck && evaluateSkipBypassTaint(liveForCompletenessCheck).blocked) {
      executorLog.warn(`${task.id}: skipping recoverCompletedTask — skip-bypass taint active (steps skipped after a bulk-step-completion refusal)`);
      await deps.store.logEntry(
        task.id,
        "Auto-promotion withheld: steps were skipped after a bulk-step-completion refusal with no accepted fn_task_done — requires reviewer or operator sign-off",
        undefined,
        deps.getRunContextFor(task.id),
      ).catch(() => undefined);
      return false;
    }

    /*
    FNXC:Lifecycle 2026-07-16-10:30:
    FN-8141 defense-in-depth: recoverCompletedTask is the shared promotion chokepoint for BOTH
    self-healing sweeps AND the executor's own unpause / resumeOrphaned fast-paths. A task whose
    most recent execution-outcome in the durable log was a failure/refusal park must not be
    promoted to in-review by ANY route, even one that re-derived completion from all-steps-done/
    skipped (skipped counts as complete, which is exactly how FN-8141 laundered a failed task).
    The self-healing sweeps additionally emit the deduped no-action audit event; here we simply
    refuse. Escape hatch: an operator retrying the task starts a fresh execution whose clean
    completion marker supersedes the failure park, clearing this block with no code change.
    */
    const failureProvenance = evaluateCompletedPromotionFailureProvenance(liveForCompletenessCheck ?? task);
    if (failureProvenance.blocked) {
      executorLog.debug(`${task.id}: skipping recoverCompletedTask — most recent execution ended in a failure/refusal park (operator-decides)`);
      return false;
    }

    const settings = await deps.store.getSettings();
    if (settings.globalPause || settings.enginePaused) {
      executorLog.log(
        `${task.id}: skipping recoverCompletedTask — ${
          settings.globalPause ? "global pause" : "engine pause"
        } active`,
      );
      return false;
    }

    const { task: authoritativeRecoveryTask, route: externalExecutionRoute } =
      await resolveAuthoritativeExternalExecutionRoute(deps.store, task);
    if (externalExecutionRoute.configured && !externalExecutionRoute.valid) {
      executorLog.warn(`${task.id}: completed-task recovery refused invalid external execution checkout: ${externalExecutionRoute.reason ?? "unknown error"}`);
      return false;
    }
    const recoveryWorktreePath = externalExecutionRoute.configured
      ? externalExecutionRoute.checkoutPath
      : authoritativeRecoveryTask.worktree;

    // Capture modified files if the authoritative execution checkout still exists.
    if (recoveryWorktreePath && existsSync(recoveryWorktreePath)) {
      const modifiedFiles = await deps.captureModifiedFiles(recoveryWorktreePath, authoritativeRecoveryTask.baseCommitSha, task.id, undefined, "recovery");
      if (modifiedFiles.length > 0) {
        await deps.store.updateTask(task.id, { modifiedFiles });
        executorLog.log(`${task.id}: recovered ${modifiedFiles.length} modified files`);
      }

      /*
      FNXC:FastLane 2026-08-29-03:35:
      Fast now bypasses every pre-merge optional group, including stale explicit selections. A
      completed Fast card must not re-enter solely to run a gate its route intentionally omits;
      its normal graph pass records skipped evidence before merge instead.
      */
      const enabledWorkflowStepsAlreadySatisfied = isFastExecutionMode(task)
        ? true
        : areEnabledPreMergeWorkflowStepsSatisfied(liveForCompletenessCheck);
      const shouldReenterWorkflowGraph = !isFastExecutionMode(task) && !enabledWorkflowStepsAlreadySatisfied;

      // Run workflow steps before transitioning — fast mode still honors explicit optional-step selections.
      if (enabledWorkflowStepsAlreadySatisfied) {
        /*
        FNXC:WorkflowLifecycle 2026-06-29-04:37:
        Completed graph-owned tasks can be observed briefly as in-progress after
        the main graph already recorded every enabled pre-merge gate. Recovery
        must not restart the graph from parse in that state; foreach pins from
        the completed run make parse fail with pin-mismatch. Hand off to review
        instead, which is the same terminal seam the completed graph reached.
        */
        executorLog.log(`${task.id}: completed recovery found satisfied workflow gates — skipping graph re-entry`);
      } else if (shouldReenterWorkflowGraph) {
        if (await deps.shouldDeferCompletionForGlobalPause(task.id, "before workflow-graph re-entry during completed-task recovery")) {
            return false;
          }
          /*
          FNXC:WorkflowExecution 2026-06-25-00:00:
          U4 (KTD-2) watchdog re-entry. The legacy `runWorkflowSteps` recovery path
          was deleted; the workflow graph is the sole executor. A stranded completed
          task is recovered by RE-ENTERING the graph via `executeWorkflowGraph`
          (the same entry execute() uses), which: (1) re-runs any pending
          optional-group / gate nodes, (2) records their outcomes into
          `task.workflowStepResults` (U2) and emits the `[pre-merge]` logs, and
          (3) OWNS the in-review vs back-for-fix transition. The graph's execute seam
          registers the normal completion interceptor, so a task whose implementation
          already completed resumes at the post-implementation nodes (it does not
          re-run the agent from scratch). RECOVERY POLICY mapping (per plan U4): the
          old "any failure including REVISE is hard" recovery rule now maps onto the
          graph's gate semantics — a GATE node REVISE/failure routes the task back for
          fix, while an ADVISORY REVISE is non-blocking and proceeds to review. KTD-5:
          for a store lacking `getTaskWorkflowSelection` that has enabled steps,
          `executeWorkflowGraph` itself fails closed (parks) rather than letting
          recovery silently skip the gates.
          */
          /*
          FNXC:WorkflowExecution 2026-07-19-17:55 (U10b / R9):
          Re-entry is unconditional. This used to branch on a `graphOwned` boolean and, when
          the graph "declined", fall through to the legacy in-review handoff below. The graph
          can no longer decline — the fallback is deleted — so that fall-through was a path
          where recovery could reach review having skipped the gates it re-entered to run.
          The handoff below is still reachable, but now only via the two branches that have
          legitimately decided there is nothing left to gate: gates already satisfied, or
          fast mode with no unsatisfied explicit selection.
          */
          await deps.executeWorkflowGraph(task);
          deps.clearCompletedTaskWatchdog(task.id);
          await deps.store.logEntry(
            task.id,
            `Auto-recovered: stranded completed task re-dispatched through the workflow graph — the graph re-ran pending workflow steps (recording results) and owns the in-review / back-for-fix transition`,
          ).catch(() => undefined);
          executorLog.log(`✓ ${task.id} auto-recovered completed task via workflow-graph re-entry`);
          return true;
      } else if (isFastExecutionMode(task)) {
        /*
        FNXC:FastOptionalSteps 2026-06-30-12:00:
        Fast recovery can hand off completed implementation directly only when the operator did not explicitly enable optional workflow steps, or when those enabled steps already have passed pre-merge results. Explicit optional selections are stronger than the fast default, so completed-task recovery must re-enter the workflow graph before review when any selected optional group is still unsatisfied.
        */
        executorLog.debug(`${task.id}: fast mode — no unsatisfied explicit workflow steps on auto-recovery`);
      }
    }

    if (await deps.shouldDeferCompletionForGlobalPause(task.id, "before in-review transition during completed-task recovery")) {
      return false;
    }
    await deps.persistTokenUsage(task.id);
    const originColumn = task.column;
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-09:30 (Phase C convergence):
    Resolved from the task's OWN workflow. On a renamed board the literals matched nothing,
    so completed work stranded in the planning lane was NOT recognised as needing promotion:
    the code fell through to `handoffTaskToReview` directly from the planning column, and
    role adjacency has no planning -> review edge, so the handoff move was rejected and the
    card stayed stranded with its work finished and nothing left to rescue it. This is the
    recovery of last resort — a literal here means the last resort does not exist off the
    default lineage.
    */
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (the sync resolver never resolved):
    AWAITED, because this method is async and the sync twin is a no-op in production.

    The note above says a literal here "means the last resort does not exist off the default
    lineage". `resolvePlannerLanes` was that literal wearing a trait lookup: its selection reader
    returns undefined unconditionally in PostgreSQL mode, so it resolved the DEFAULT workflow for
    every card and `promotedFromPlannerColumn` was false on every renamed board — the exact
    stranding this recovery exists to fix, with the conversion in place and the census counting it.

    Same struct, same fallbacks, one await. `recoverCompletedTask` has already awaited store reads
    by this point, so this adds no ordering constraint it did not already have.
    */
    const plannerLanes = await resolvePlannerLanesForTaskAsync(deps.store, task.id);
    const promotedFromPlannerColumn = originColumn === plannerLanes.hold || originColumn === plannerLanes.intake;
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-16:45 (PR #2628 review, greptile P1):
    REFUSE BEFORE THE FIRST MOVE when the workflow declares no WIP lane. The previous version
    let `resolvePlannerLanes` substitute the legacy `in-progress`, so the promotion targeted a
    column that board does not declare: `moveTask` rejects it, recovery reports failure — and
    because the intake -> hold re-home happens FIRST, the card could be left half-moved, which
    is worse than the stranding this recovery exists to fix.

    Checked here rather than at the move so no partial hop is issued. A workflow with planning
    lanes and no WIP lane has nowhere to promote completed work TO; that is an operator
    configuration question, not something to guess past. Logged so the card is not silently
    skipped — the whole point of this recovery is that nothing else owns this state.
    */
    if (promotedFromPlannerColumn && plannerLanes.wip === undefined) {
      const message = `Auto-recovery withheld: completed work is in '${originColumn}' but this workflow declares no WIP column to promote it to`;
      executorLog.warn(`${task.id}: ${message}`);
      await deps.store.logEntry(task.id, message).catch(() => undefined);
      return false;
    }
    let completionTask = task;
    if (promotedFromPlannerColumn) {
      deps.recoveringCompleted.add(task.id);
      /*
      FNXC:WorkflowLifecycle 2026-07-20-08:42:
      Advanced-triage recovery reaches this shared seam with completed work, a
      preserved worktree, and a durable merge pin. The workflow transition map
      deliberately rejects triage -> in-review, so re-home through the legal
      triage -> todo -> in-progress path while the recovery ownership set prevents
      scheduler/executor dispatch. Todo callers retain their existing single hop.
      */
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-09:30: the two-hop is needed whenever the
      card sits in a DISTINCT intake lane, because role adjacency gives intake only
      hold — never wip. Post-U11 the default lineage merges intake and hold onto one
      column, so `hold === intake` and the hop correctly collapses to the single move below;
      a board that still separates them (pre-U11, or a custom lineage) keeps the re-home.
      */
      if (originColumn === plannerLanes.intake && plannerLanes.hold !== plannerLanes.intake) {
        completionTask = await deps.store.moveTask(task.id, plannerLanes.hold, {
          moveSource: "engine",
          recoveryRehome: true,
          bypassGuards: true,
          preserveProgress: true,
          preserveWorktree: true,
          preserveResumeState: true,
        });
      }
      // Non-undefined: the guard above returned early when this workflow declares no WIP lane.
      completionTask = await deps.store.moveTask(task.id, plannerLanes.wip as string);
    }
    await deps.handoffTaskToReview(completionTask, "completed-task-recovered");
    if (promotedFromPlannerColumn) {
      deps.recoveringCompleted.delete(task.id);
    }
    deps.clearCompletedTaskWatchdog(task.id);
    await deps.store.logEntry(task.id, `Auto-recovered: task work was complete but stranded in ${originColumn} — moved to in-review`);
    executorLog.log(`✓ ${task.id} auto-recovered completed task → in-review`);
    deps.signalTaskComplete(task);
    return true;
  } catch (err: unknown) {
    deps.recoveringCompleted.delete(task.id);
    const errorMessage = err instanceof Error ? err.message : String(err);
    executorLog.error(`Failed to recover completed task ${task.id}: ${errorMessage}`);
    return false;
  }
}
