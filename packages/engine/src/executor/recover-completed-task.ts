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
  resolveLifecycleColumns,
  resolveWorkflowIrForTaskWithProvenance,
  workflowHasColumn,
} from "@fusion/core";
import { resolvePlannerLanesForTaskAsync } from "../execution/replan-target.js";
import type { PlannerLanes } from "../execution/replan-target.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { resolveAuthoritativeExternalExecutionRoute } from "./resolve-authoritative-external-execution-route.js";
import { isTaskWorkComplete } from "./task-predicates.js";
import { areEnabledPreMergeWorkflowStepsSatisfied } from "./workflow-step-satisfaction.js";

/*
FNXC:WorkflowLifecycleColumns 2026-09-19-07:22:
The promotion decision consumes a lane answer and a column, and those come from two independent
store reads (the task's workflow SELECTION, and the task ROW). This is the equality the decision
needs to know they describe the same board: role ids and the provenance flag, which are the whole
of what `promotedFromPlannerColumn` and the hop targets read. Comparing the structs is deliberately
cheaper and stricter than re-deriving an answer — two structurally identical answers are
interchangeable for this decision whether or not they came from the same object.
*/
function samePlannerLanes(a: PlannerLanes, b: PlannerLanes): boolean {
  return a.hold === b.hold
    && a.intake === b.intake
    && a.wip === b.wip
    && a.review === b.review
    && a.complete === b.complete
    && a.resolvedFromWorkflow === b.resolvedFromWorkflow;
}

/*
FNXC:WorkflowLifecycleColumns 2026-10-02-14:35 (orphans are named by the board's VOCABULARY, not by
two lane answers disagreeing):

THE RE-HOME USED TO ASK WHETHER THE LANES DISAGREED, which cannot tell an orphan from a requeue
and cannot tell a board edit from a resolver that stopped answering. It now asks the board in
force one question — does it DECLARE the column this card is sitting in? — which is the same
question `moveTaskInternal` and `reconcileUndeclaredTaskColumns` ask, so the answer is the one the
next move will be judged by:

  - A DECLARED column is never an orphan. Hold, intake, review and terminal lanes are all
    declared, so a card re-queued into hold by a pause/resume abort is left alone and the ordinary
    promotion runs from it on the next sweep, instead of being dragged into WIP.
  - An UNDECLARED column is an orphan, whatever the lanes said, including when both answers are
    the legacy fallback: a fallback names no board and can never prove a source is undeclared, so
    an unreadable workflow withholds rather than guessing.
  - The destination is the WIP lane of THIS board, not of an earlier read.

Provenance decides, not a lane flag: `resolveWorkflowIrForTask` substitutes the default board
whenever a named workflow will not load, and a card re-homed against the DEFAULT's vocabulary is
the guess this guard exists to prevent. So a named-but-unloadable workflow withholds, while a card
with no selection at all legitimately resolves to the default.
*/
async function resolveOrphanedColumnRehome(
  store: TaskStore,
  taskId: string,
  sourceColumn: string,
): Promise<{ rehomeTo: string } | { reason: string; withhold?: true }> {
  const { ir, source, selectionAbsent } = await resolveWorkflowIrForTaskWithProvenance(store, taskId);
  if (source !== "selection" && selectionAbsent !== true) {
    return { reason: `its workflow could not be loaded, so any rebound target would be a guess`, withhold: true };
  }
  /*
  FNXC:WorkflowLifecycleColumns 2026-10-02-14:57 (the source column is re-read AFTER the authority resolves):

  `sourceColumn` is a VALUE captured before the await above, so a pause/resume abort that re-queues the
  row during it leaves every question below about a column the row no longer occupies: `building` is
  undeclared on the board now in force, the answer is `rehomeTo: <that board's WIP>`, and the
  `moveTask(..., { recoveryRehome: true })` the caller issues on that answer skips adjacency toward a
  DECLARED target — so a requeue into a DECLARED hold lane is promoted straight to WIP anyway, which is
  the third promotion the 14:20 case stops when the requeue lands one await earlier. Re-reading the
  authoritative row here closes that window for BOTH callers at once, because this is their shared seam.

  IT IS NOT A COMPARGE-AND-SWAP ACROSS PROCESSES. What this re-read covers is the awaits inside
  THIS helper; the window between this read and the store call each caller issues next is closed by
  that caller's `moveTaskIf` predicate (FNXC:WorkflowLifecycleColumns 2026-10-02-16:40), which re-reads
  the row under the task lock and only moves while the row still says what this read said. A writer in
  another process, or one writing straight to the database, can still land between the store's own
  preflight and its transaction — no in-process fence can see that, and nothing here claims to.

  AND A FAILED READ IS NOT A PASS. `live` used to be `await ... .catch(() => undefined)` with the
  mismatch check behind a `live &&` guard, so a read that failed or returned nothing skipped the guard
  entirely and the decision below was made about `sourceColumn` — the value captured BEFORE the await
  above, which is exactly the value this function exists to distrust. An unreadable row is therefore an
  explicit withhold now: no board can be asked whether an unknown column is declared, and guessing is
  what strands completed work.

  And a withhold is not a stranding: the row is then sitting in a DECLARED hold lane, or in an
  undeclared column the next sweep re-derives an answer for, so recovery converges either way.
  */
  const live = await store.getTask(taskId).catch(() => undefined);
  if (!live) {
    return {
      reason: `its column could not be read back, so this board cannot be asked whether that column is declared`,
      withhold: true,
    };
  }
  if (String(live.column ?? "") !== sourceColumn) {
    return {
      reason: `the card moved to '${live.column ?? "unreadable"}' while its workflow was being resolved`,
      withhold: true,
    };
  }
  // The ONE benign answer: a DECLARED column is not an orphan. It carries no `withhold`, so a caller
  // whose question was "is this column safe to hand off from" may hand off and one that was "should this
  // card be re-homed" may simply decline — both are the ordinary path for a legitimate lane.
  if (workflowHasColumn(ir, sourceColumn)) {
    return { reason: `'${sourceColumn}' is a column this board declares` };
  }
  const wip = resolveLifecycleColumns(ir)?.wip;
  if (wip === undefined || wip === sourceColumn) {
    return {
      reason: `this board declares no WIP column to re-home '${sourceColumn}' to`,
      withhold: true,
    };
  }
  return { rehomeTo: wip };
}

/**
 * FNXC:WorkflowLifecycleColumns 2026-10-03 (a declined hop ends the chain, it does not warn it):
 * Thrown to leave the two-hop chain the moment a hop is declined, so the promotion after a declined
 * re-home is never issued. It carries NO message on purpose — `hopFailure` already holds the precise
 * reason, and the catch below must not replace that with a generic one. Not exported: the control
 * flow is internal to this module and the observable outcome is the withhold, not the throw.
 */
class HopChainDeclined extends Error {}

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
    /*
    FNXC:WorkflowLifecycleColumns 2026-08-25-10:15 (stale-snapshot race):
    `originColumn` must come from the AUTHORITATIVE re-read, not the caller's `task`
    snapshot. A pause/resume abort can benignly re-queue the card (in-progress → todo)
    between the caller's capture and this recovery; deciding promotion from the stale
    snapshot skips the todo → wip re-home hop and hands off straight from `todo`,
    which `handoffToReview` rejects ("Invalid transition: 'todo' → 'in-review'")
    and strands the completed card. Observed on GDPR-052: unpause-resume captured
    column=in-progress while the live row had already been re-queued to todo.
    FNXC:WorkflowLifecycleColumns 2026-08-25-10:20 (late-mutation re-read):
    The task row was last read before awaited recovery work (captureModifiedFiles, gate
    evaluation), and lane resolution also awaits. A pause/resume abort can re-queue the row
    (in-progress → todo) in any of those windows, so lane resolution happens FIRST and one
    final getTask follows it immediately before the promotion decision — nothing awaits
    between that read and the moves it feeds. Seed BOTH `originColumn` and `completionTask`
    from this freshest read. A failed read returns via the outer catch: recovery retries on
    the next sweep rather than acting on known-stale state.

    FNXC:WorkflowLifecycleColumns 2026-09-19-07:22 (one coherent snapshot):
    RESOLVING THE LANES AND READING THE COLUMN ARE TWO INDEPENDENT READS, so as written above
    they can straddle a workflow-selection change: the lanes would describe the workflow the
    card was on and `originColumn` the row it is on now. Recovery then either skips a required
    promotion or moves toward a lane the card's own workflow does not declare — and because
    the intake -> hold re-home runs FIRST, a rejected later hop leaves the completed card
    parked in an intermediate lane.

    Both halves are closed here. The lanes are resolved ON BOTH SIDES of the row read, and two
    structurally identical answers prove no selection change landed inside the window — the
    only change the sandwich cannot see is one whose lanes are identical, which cannot alter
    this decision. A disagreement withholds recovery with a log and retries on the next sweep,
    because acting on a board that is being re-selected under us is exactly the move that
    would relocate a card the new board does not own. The hop chain is then verified after it
    runs: a rejected or silently-dropped hop must not leave the card half-re-homed without
    that outcome being explicit.

    FNXC:WorkflowLifecycleColumns 2026-09-26-12:05 (the sandwich is a LANE guard, not a column guard):
    THE SAME REQUEUE STILL GOT THROUGH WITH THE LANES HELD CONSTANT. A pause/resume abort that
    re-queued the row during the SECOND lane resolution left the row read describing a card that
    had since moved: `samePlannerLanes` still returned true — correctly, because a requeue is not
    what changes a workflow's lanes — the todo -> wip hop was skipped, and the completed card
    stranded with its work done. The row and the lanes are INDEPENDENT reads; bracketing the row
    between two lane answers proves the lanes were stable around it, and says nothing about the
    row's own movement during the closing await. Guarding one read by re-reading the other is not
    a guard on the first.

    So the row is read LAST, after the lane answer is settled, and that read seeds both
    `originColumn` and `completionTask`: nothing awaits between it and the moves it feeds. The
    lane sandwich is kept and still does its own job — each resolution itself awaits a selection
    read and then a definition read, so two identical answers prove no selection change landed
    across that whole window. A change arriving after the row read is a race no ordering of reads
    can win, and the landing check below already names the lane it contradicts. A column that
    moves between the row read and the first hop is likewise unwinnable here, and is reported by
    the same landing check rather than silently accepted.
    */
    const lanesBeforeSnapshotRead = await resolvePlannerLanesForTaskAsync(deps.store, task.id);
    const plannerLanes = await resolvePlannerLanesForTaskAsync(deps.store, task.id);
    if (!samePlannerLanes(lanesBeforeSnapshotRead, plannerLanes)) {
      const message = `Auto-recovery withheld: the task's planner lanes changed while the promotion snapshot was being read — the lane target and the origin column would come from two different workflow selections`;
      executorLog.warn(`${task.id}: ${message}`);
      await deps.store.logEntry(task.id, message).catch(() => undefined);
      return false;
    }
    const prePromotionTask = await deps.store.getTask(task.id);
    const originColumn = prePromotionTask.column;
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

    */
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
    /*
    FNXC:WorkflowLifecycleColumns 2026-08-25-10:15 (stale-snapshot race, part 2):
    Seed from the AUTHORITATIVE re-read, not the caller snapshot — the handoff
    receives this object, and a stale column here mislabels the promoted card
    (and its logs) even though handoffToReview re-reads internally.
    */
    let completionTask: Task = prePromotionTask;
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
      hold/archived — never wip. Post-U11 the default lineage merges the two roles onto one
      column, so `hold === intake` and the hop correctly collapses to the single move below;
      a board that still separates them (pre-U11, or a custom lineage) keeps the re-home.
      */
      /*
      FNXC:WorkflowLifecycleColumns 2026-09-19-07:22 (no silent partial re-home):
      THE TRAP THIS SEQUENCE SETS. The intake -> hold re-home runs FIRST, so when the
      promotion into wip is then rejected the card is already one lane off where it started
      — half-re-homed, with its work finished, and the outer catch reporting only a generic
      failure. The same is true when a move resolves without moving the row: the card stays
      in the hold lane and recovery still claims success.

      So the chain is verified against the row rather than against the call it made. A hop
      that throws, or a chain that reports success without landing the card in
      `plannerLanes.wip`, withholds the handoff and records exactly where the card is and
      where it was going. Recovery then reports false, and the next sweep re-enters from the
      lane the card is actually in — which is the honest recovery, not a mutation of a row
      whose move the board rejected. The ownership entry is released here because the outer
      catch is no longer what unwinds this case.
      */
      let hopFailure: string | undefined;
      /*
      FNXC:WorkflowLifecycleColumns 2026-10-02-21:05 (the second hop answers about a row it never
      read): hop 1 is issued, awaited, and only then is hop 2 issued — but hop 2 was UNCONDITIONAL,
      so a pause/resume abort that re-queued the card inside that await was overwritten by it, and
      completed work was dragged into WIP out of the very lane the abort was making room for. That
      is the same window hop 1's fence exists for, one move later, and the fix is the primitive
      already in this file: the column hop 1's answer was about becomes a predicate the store
      evaluates against the row it reads UNDER THE TASK LOCK, so the promotion happens only while
      the card still says what recovery decided about it. `moved: false` is that answer arriving
      late and is reported as a hop failure, which the landing check below turns into the same
      withhold it already turns a refused landing into — the card stays where the requeue put it and
      the next sweep promotes from there. In-process fence, same scope as the re-home fence: no
      claim of a cross-process CAS.
      */
      /*
      FNXC:WorkflowLifecycleColumns 2026-10-03 (hop 1 was the last unfenced move in the chain):
      hop 2 was fenced on 21:05 and both re-home callers on 16:40, but this FIRST hop was still an
      unconditional `moveTask` — so the two hops that make up one chain had different fencing over the
      SAME window, and this one is the earlier of the two. Recovery decided `hold` from its snapshot,
      a concurrent writer moved the row while this move waited on the task lock, and the move then
      dragged the card into the lane recovery had decided about.

      `recoveryRehome` is what made that silent: it SKIPS adjacency in `moveTaskInternal`, so a move
      out of the lane a requeue chose is accepted rather than refused — and hop 2's predicate then
      observes the column this hop manufactured, promotes from it, and the landing check passes, so
      the overwrite was never reported. A card re-queued to make room was put into WIP anyway.

      So the fence is the one hop 2 already uses: the column this hop was decided about becomes a
      predicate the store evaluates against the row it reads UNDER THE TASK LOCK, and `moved: false`
      is that answer arriving late — reported as a hop failure, which the landing check below turns
      into the same withhold it already turns a refused landing into. The card stays where the
      requeue put it and the next sweep promotes from there. Same in-process scope as hop 2's fence:
      no claim of a cross-process CAS.
      */
      try {
        if (originColumn === plannerLanes.intake && plannerLanes.hold !== plannerLanes.intake) {
          const rehomeToHold = await deps.store.moveTaskIf(
            task.id,
            plannerLanes.hold,
            (live) => String(live.column ?? "") === originColumn,
            {
              moveSource: "engine",
              recoveryRehome: true,
              bypassGuards: true,
              preserveProgress: true,
              preserveWorktree: true,
              preserveResumeState: true,
            },
          );
          if (!rehomeToHold.moved) {
            hopFailure = `the card left '${originColumn}' before the re-home to '${plannerLanes.hold}' could be applied`;
          }
        }
        /*
        FNXC:WorkflowLifecycleColumns 2026-10-03 (a declined hop CONCLUDES the chain):
        A DECLINED HOP IS EVIDENCE THE CARD MOVED, so the promotion must not be issued on a row that
        evidence already condemned — and in the lane hop 1 was TARGETING the decline is not enough on
        its own. Hop 1's predicate asks "is the row still in `originColumn`?"; a requeue that put the
        card straight into `plannerLanes.hold` makes that false, so hop 1 declines — while hop 2's
        predicate asks "is the row in the lane hop 1 was decided about?", which is now TRUE precisely
        because the requeue put it there. So the chain promoted straight out of the requeue and the
        landing check passed on the promotion: the same overwrite the fence above exists to prevent,
        arriving from the other side.

        So a decline short-circuits rather than being recorded and overwritten. The withhold below
        still runs — it names the refusal and names where the card actually is — and the next sweep
        re-derives from the settled lane the requeue chose, which is the convergent behaviour the
        2026-10-02-21:05 fence established for hop 2.
        */
        if (hopFailure !== undefined) {
          throw new HopChainDeclined();
        }
        // Non-undefined: the guard above returned early when this workflow declares no WIP lane.
        const promotion = await deps.store.moveTaskIf(
          task.id,
          plannerLanes.wip as string,
          // The column the promotion was decided about: hop 1's destination when it ran, else the
          // column this sweep read. Both are the declared lane the card must still be sitting in.
          (live) => {
            const expected = originColumn === plannerLanes.intake && plannerLanes.hold !== plannerLanes.intake
              ? plannerLanes.hold
              : originColumn;
            return String(live.column ?? "") === expected;
          },
        );
        if (!promotion.moved) {
          hopFailure = hopFailure
            ?? `the card left the lane this promotion was decided about before the move to '${plannerLanes.wip}' could be applied`;
        }
      } catch (error: unknown) {
        // The sentinel carries no message of its own: `hopFailure` already names WHY the chain
        // stopped, and overwriting it here would replace a precise refusal with "chain declined".
        if (!(error instanceof HopChainDeclined)) {
          hopFailure = hopFailure ?? (error instanceof Error ? error.message : String(error));
        }
      }
      /*
      FNXC:WorkflowLifecycleColumns 2026-10-02-00:12: THE LANDING ROW IS READ AFTER THE LANE
      RESOLUTION THAT VERIFIES IT, so a re-queue inside that await withholds the handoff instead of
      letting recovery report success on a row the store already moved. Nothing awaits between that
      read and the comparison consuming it — the same invariant the pre-hop read already holds.
      */
      const lanesAtLanding = await resolvePlannerLanesForTaskAsync(deps.store, task.id);
      const landed = await deps.store.getTask(task.id).catch(() => undefined);
      /*
      FNXC:WorkflowLifecycleColumns 2026-09-19-07:22 (one coherent snapshot, part 3):
      VERIFY THE LANDING AGAINST THE WORKFLOW IN FORCE, not the snapshot's. Comparing to
      `plannerLanes.wip` answered with the lane the DECISION wanted, so a selection change that
      landed after the snapshot and before these hops would still validate a move toward a lane
      the card's workflow no longer calls WIP — the check would agree with the stale answer it
      was meant to catch. Re-resolving here answers the question the handoff actually depends
      on: is the card in WIP for the board it is on NOW. A change that arrives after this read
      is caught by the landing it contradicts, not silently accepted.
      */
      if (landed === undefined || landed.column !== lanesAtLanding.wip) {
        /*
        FNXC:WorkflowLifecycleColumns 2026-10-02-14:35 (the withhold was the bug, not the fix):
        REFUSING THE HANDOFF IS NOT A RECOVERY. The card is completed work sitting in a column
        the board in force does not declare, so `promotedFromPlannerColumn` is false for it on
        every later sweep, every sweep hands off from that same dead source, and the real
        `moveTaskInternal` rejects it each time (`resolveAllowedColumns` has no adjacency for an
        undeclared source and falls to the rebound escape hatch). Withheld once, stranded until
        an engine restart, which is the only thing that runs
        `reconcileUndeclaredTaskColumns` — the correct rescue, on the wrong cadence.

        A declared source is left alone. A pause/resume abort re-queues a card into a DECLARED
        hold lane, and that is not an orphan: it is the ordinary promotion's next input, so this
        sweep withholds and the next one promotes from there. Answering "the lanes disagree" by
        moving the card instead would discard the requeue and put completed work into WIP behind
        whatever the abort was making room for.

        The withhold, the ownership release and the lane-naming log below are unchanged, and a
        re-home that the store still rejects reports the lane the card is in.
        */
        /*
        FNXC:WorkflowLifecycleColumns 2026-10-02-16:40 (the re-home is fenced on the row, not on the
        answer): the helper's re-read and this move are separated by awaits, so a requeue landing in
        BETWEEN left `moveTask` acting on a column the row no longer occupied — and `recoveryRehome`
        skips adjacency, so the move out of a DECLARED requeue lane was accepted: a third promotion
        that discards what the requeue was making room for.

        `moveTaskIf` closes it the way `hold-release.ts` already closes its own admission window: the
        captured column becomes a predicate the store evaluates against the row it reads UNDER THE
        TASK LOCK, so the move happens only while the row still says what the helper answered about.
        `moved: false` is that answer arriving late, and it is reported as a withhold — never as a
        re-home. This fence is IN-PROCESS: another process or a direct database write can still land
        between the store's preflight and its transaction, so this is not a cross-process CAS and
        the next sweep still re-derives from a settled board.
        */
        const orphanedColumn = String(landed?.column ?? "");
        const rehome = await resolveOrphanedColumnRehome(deps.store, task.id, orphanedColumn);
        /*
        FNXC:WorkflowLifecycleColumns 2026-10-02-21:05 (the log has to say where the card IS): the
        withhold message below is built from `landed`, which was read BEFORE this re-home, so a
        re-home that SUCCEEDED was reported as the card still sitting in the column it was re-homed out
        of — and with no hop failure to explain the refusal, as "both hops reported success" on a chain
        whose promotion had just been refused. The row the store RETURNS from the move is the post-move
        row it read under the task lock, so naming its column costs no extra await; a re-home that did
        not move leaves the pre-re-home answer, which is then the honest one to report.
        */
        let columnAfterRehome: string | undefined;
        if ("rehomeTo" in rehome) {
          try {
            const rehomeResult = await deps.store.moveTaskIf(
              task.id,
              rehome.rehomeTo,
              (live) => String(live.column ?? "") === orphanedColumn,
              {
                moveSource: "engine",
                recoveryRehome: true,
                bypassGuards: true,
                preserveProgress: true,
                preserveWorktree: true,
                preserveResumeState: true,
              },
            );
            if (!rehomeResult.moved) {
              hopFailure = hopFailure ?? `the card left '${orphanedColumn}' before the re-home to '${rehome.rehomeTo}' could be applied`;
            } else {
              columnAfterRehome = String(rehomeResult.task?.column ?? rehome.rehomeTo);
              // A re-home that landed explains the refusal on its own, and saying so keeps the
              // fallback below from reporting a refused chain as "both hops reported success".
              hopFailure = hopFailure ?? `re-homed to '${columnAfterRehome}' so a later sweep can hand it off`;
            }
          } catch (rehomeError: unknown) {
            hopFailure = rehomeError instanceof Error ? rehomeError.message : String(rehomeError);
          }
        } else {
          // A hop that already reported WHY it failed keeps that reason: it names the move the
          // store actually refused, which is more useful than the fact that no re-home followed.
          hopFailure = hopFailure ?? `not re-homed: ${rehome.reason}`;
        }
        const message = `Auto-recovery withheld: promotion of completed work from '${originColumn}' did not land in '${lanesAtLanding.wip}' — the card is in '${columnAfterRehome ?? landed?.column ?? "unreadable"}' (${hopFailure ?? "both hops reported success"})`;
        executorLog.warn(`${task.id}: ${message}`);
        await deps.store.logEntry(task.id, message).catch(() => undefined);
        deps.recoveringCompleted.delete(task.id);
        return false;
      }
      completionTask = landed;
    } else {
      /*
      FNXC:WorkflowLifecycleColumns 2026-10-02-14:35 (the repair has to run on the LATER attempt too):
      THE RE-HOME ABOVE ONLY RUNS INSIDE THE PROMOTION BRANCH, so a card that a board edit left in
      an undeclared column never reaches it: `promotedFromPlannerColumn` is false for that card on
      every sweep after the edit, so the branch is skipped entirely and the card is handed off from
      a column its workflow does not declare. `resolveAllowedColumns` has no adjacency for an
      undeclared source and falls to the rebound escape hatch, so the real handoff is rejected every
      time — completed work, stranded until an engine restart runs `reconcileUndeclaredTaskColumns`.

      A selection change landing WHILE the landing lanes resolve is what produces that card, and no
      read order inside one sweep can see it: the landing read answers with the board that was in
      force when it started, so its verdict is about a board that no longer exists. The honest
      recovery is therefore on the next attempt, where the edit has settled and the column is
      simply undeclared.

      So the non-promotion path asks the same one question before handing off, and a card in a
      DECLARED column — every legitimate hold, intake, review and terminal lane — walks straight
      past it. Nothing is deleted and nothing moves backward: the re-home carries the same
      `preserve*` options and `recoveryRehome` the unreachable-source move requires.
      */
      const orphan = await resolveOrphanedColumnRehome(deps.store, task.id, originColumn);
      if ("rehomeTo" in orphan) {
        /*
        FNXC:WorkflowLifecycleColumns 2026-10-02-16:40: same fence as caller 1 — the predicate is the
        column this sweep captured, evaluated against the row under the task lock, and `moved: false`
        is reported as a withhold rather than a re-home that did not happen.
        */
        /*
        FNXC:WorkflowLifecycleColumns 2026-10-02-19:40 (a re-home is not a dispatch): THE RE-HOME LANDS
        IN WIP, so the store publishes `task:moved` with `to = wip` and the executor's own listener
        reads that as a fresh run and starts an agent. Caller 1 already holds the recovery claim when
        it re-homes, which is why only this caller dispatched. So completed work was re-executed by
        the very move meant to leave it alone — the agent re-runs steps the card already finished,
        on a card whose progress and worktree the re-home deliberately preserved.

        The claim is the guard that already exists for exactly this (`wire-executor-lifecycle` skips
        `execute()` while the id is owned), and it is scoped to the move: taken only when this
        caller does not already own it, and released on every exit below. Releasing it is what keeps
        recovery convergent — the next sweep re-derives from a settled board and hands the card off
        instead of the ownership entry wedging the watchdog, the sweeps and `isTaskActive` shut.
        */
        const ownsRecoveryClaim = !deps.recoveringCompleted.has(task.id);
        if (ownsRecoveryClaim) deps.recoveringCompleted.add(task.id);
        const releaseClaim = () => {
          if (ownsRecoveryClaim) deps.recoveringCompleted.delete(task.id);
        };
        try {
          const rehomeResult = await deps.store.moveTaskIf(
            task.id,
            orphan.rehomeTo,
            (live) => String(live.column ?? "") === originColumn,
            {
              moveSource: "engine",
              recoveryRehome: true,
              bypassGuards: true,
              preserveProgress: true,
              preserveWorktree: true,
              preserveResumeState: true,
            },
          );
          if (!rehomeResult.moved) {
            const withheld = `Auto-recovery withheld: completed work is stranded in '${originColumn}', a column this workflow no longer declares — the card left that column before the re-home to '${orphan.rehomeTo}' could be applied, so it was left where it is`;
            executorLog.warn(`${task.id}: ${withheld}`);
            await deps.store.logEntry(task.id, withheld).catch(() => undefined);
            releaseClaim();
            return false;
          }
        } catch (rehomeError: unknown) {
          const message = `Auto-recovery withheld: completed work is stranded in '${originColumn}', a column this workflow no longer declares, and the re-home to '${orphan.rehomeTo}' was rejected: ${rehomeError instanceof Error ? rehomeError.message : String(rehomeError)}`;
          executorLog.warn(`${task.id}: ${message}`);
          await deps.store.logEntry(task.id, message).catch(() => undefined);
          releaseClaim();
          return false;
        }
        const message = `Auto-recovery withheld: completed work was stranded in '${originColumn}', a column this workflow no longer declares — re-homed to '${orphan.rehomeTo}' so a later sweep can hand it off`;
        executorLog.log(`${task.id}: ${message}`);
        await deps.store.logEntry(task.id, message).catch(() => undefined);
        releaseClaim();
        return false;
      }
      /*
      FNXC:WorkflowLifecycleColumns 2026-10-02-16:40 (only a withhold-worthy answer withholds):
      THIS FALL-THROUGH IS THE HANDOFF, so the helper's answer decides whether it is safe to hand off
      from `originColumn`. Falling through on EVERY reason was wrong in one direction only: a row that
      moved, a workflow that would not load, a board with no WIP lane, and a row that cannot be read
      back all describe a column the board in force does not vouch for — and handing off from an
      undeclared source is the rejection `resolveAllowedColumns` refuses, which is how completed work
      strands in the first place. Withholding those is honest and convergent: the next sweep
      re-derives the answer from a settled board.

      A DECLARED column is the one benign answer and keeps walking past — every legitimate hold,
      intake, review and terminal lane, i.e. the ordinary promotion's inputs. Blocking on any reason
      at all would freeze those cards in WIP forever, so the split is on what the answer MEANS, not on
      whether there is one.
      */
      if (orphan.withhold === true) {
        const message = `Auto-recovery withheld: completed work is stranded in '${originColumn}', a column this workflow no longer declares — not re-homed: ${orphan.reason}`;
        executorLog.warn(`${task.id}: ${message}`);
        await deps.store.logEntry(task.id, message).catch(() => undefined);
        return false;
      }
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
