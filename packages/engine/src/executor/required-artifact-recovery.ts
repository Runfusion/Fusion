/**
 * FNXC:CodeOrganization 2026-08-03-21:35:
 * recoverMissingRequiredArtifacts peeled from TaskExecutor (U4).
 * Bounded replan recovery when required workflow artifacts are missing.
 */
import type { Task, TaskStore } from "@fusion/core";
import { computeRecoveryDecision, formatDelay, MAX_RECOVERY_RETRIES } from "../healing/recovery-policy.js";
import { moveTaskToReplanColumn, resolveReplanTargetColumn } from "../execution/replan-target.js";
import { generateSyntheticRunId, type EngineRunContext } from "../util/run-audit.js";
import { resolveTerminalColumnsFor } from "./lifecycle-columns.js";

export type RequiredArtifactRecoveryDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  isRequiredArtifactRecoveryProtected: (task: Task) => Promise<boolean>;
  workflowLifecycleMovesInFlight: Set<string>;
};

/**
 * FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet: made ASYNC to own its resolution):
 * This predicate protects a card from artifact-recovery replanning, and three of its conditions are
 * lifecycle columns: the terminal pair, and a review row whose auto-merge is off (a human owns it). As
 * literals they all read false on a renamed board — so a FINISHED card, or a review row a human was
 * holding, could be moved to the replan column and have its status rewritten to needs-replan.
 *
 * ASYNC rather than lane parameters: all four callers already `await store.getTask` immediately before
 * calling this, so there is no new I/O ordering, and a parameter list would put the resolution in four
 * places that must agree. The archived half is why the SYNC planner-lane resolver was not an option — it
 * exposes no archived lane — and widening a shared resolver from inside a call-site sweep is scope creep
 * that makes a conversion unreviewable.
 */
export async function isRequiredArtifactRecoveryProtected(
  store: TaskStore,
  resolveResumeLanes: (taskId: string) => Promise<{ review: string }>,
  task: Task,
): Promise<boolean> {
  const terminalColumns = await resolveTerminalColumnsFor(store, task.id);
  const protectionReviewLane = (await resolveResumeLanes(task.id)).review;
  return Boolean(
    task.deletedAt
    || task.paused
    || task.userPaused === true
    || terminalColumns.includes(task.column)
    || task.mergeDetails?.mergeConfirmed === true
    || (task.column === protectionReviewLane && task.autoMerge === false),
  );
}

export async function recoverMissingRequiredArtifacts(
  deps: RequiredArtifactRecoveryDeps,
  task: Task,
  artifactKeys: string[],
  source: { source: "graph-entry" | "workflow-step"; nodeId?: string },
): Promise<void> {
  const currentTask = await deps.store.getTask(task.id).catch(() => null);
  if (!currentTask || await deps.isRequiredArtifactRecoveryProtected(currentTask)) return;
  task = currentTask;
  const decision = computeRecoveryDecision({
    recoveryRetryCount: task.recoveryRetryCount,
    nextRecoveryAt: task.nextRecoveryAt,
  });
  const attempt = decision.nextState.recoveryRetryCount ?? MAX_RECOVERY_RETRIES;
  const context = deps.getRunContextFor(task.id);
  const action = decision.shouldRetry ? "replan" : "park-failed";

  await deps.store.recordRunAuditEvent?.({
    taskId: task.id,
    agentId: "executor",
    runId: context?.runId ?? generateSyntheticRunId("required-artifact-missing", task.id),
    domain: "database",
    mutationType: "task:required-artifact-missing",
    target: task.id,
    metadata: {
      taskId: task.id,
      artifactKeys,
      owner: "planning",
      source: source.source,
      action,
      attempt,
      maxAttempts: MAX_RECOVERY_RETRIES,
      ...(source.nodeId ? { nodeId: source.nodeId } : {}),
    },
  });

  if (!decision.shouldRetry) {
    const liveTask = await deps.store.getTask(task.id).catch(() => null);
    if (!liveTask || await deps.isRequiredArtifactRecoveryProtected(liveTask)) return;
    const error = `REQUIRED_ARTIFACT_RECOVERY_EXHAUSTED: ${artifactKeys.join(", ")} remained missing after ${MAX_RECOVERY_RETRIES} automatic planning retries.`;
    await deps.store.logEntry(task.id, error, undefined, context);
    await deps.store.updateTask(task.id, {
      status: "failed",
      error,
      recoveryRetryCount: null,
      nextRecoveryAt: null,
    }, context);
    return;
  }

  const replanColumn = await resolveReplanTargetColumn(deps.store, task.id);
  await deps.store.logEntry(
    task.id,
    `Required workflow artifact missing — moved to ${replanColumn} for automatic planning recovery (attempt ${attempt}/${MAX_RECOVERY_RETRIES} in ${formatDelay(decision.delayMs)})`,
    `Missing artifact keys: ${artifactKeys.join(", ")}`,
    context,
  );
  deps.workflowLifecycleMovesInFlight.add(task.id);
  try {
    const liveTask = await deps.store.getTask(task.id).catch(() => null);
    if (!liveTask || await deps.isRequiredArtifactRecoveryProtected(liveTask)) return;
    await moveTaskToReplanColumn(deps.store, { id: task.id, column: liveTask.column }, replanColumn);
  } finally {
    deps.workflowLifecycleMovesInFlight.delete(task.id);
  }
  await deps.store.updateTask(task.id, {
    status: "needs-replan",
    error: null,
    recoveryRetryCount: decision.nextState.recoveryRetryCount,
    nextRecoveryAt: decision.nextState.nextRecoveryAt,
    graphResumeRetryCount: 0,
  }, context);
}
