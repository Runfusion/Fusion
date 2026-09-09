/**
 * FNXC:CodeOrganization 2026-08-03-21:35:
 * recoverMissingRequiredArtifacts peeled from TaskExecutor (U4).
 * In-place execution recovery when required workflow artifacts are missing.
 */
import type { Task, TaskStore } from "@fusion/core";
import { computeRecoveryDecision, formatDelay, MAX_RECOVERY_RETRIES } from "../healing/recovery-policy.js";
import { generateSyntheticRunId, type EngineRunContext } from "../util/run-audit.js";
import { emitBoundedRunAudit } from "./emit-bounded-run-audit.js";
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
 * lifecycle columns: Complete, and a review row whose auto-merge is off (a human owns it). As literals
 * they read false on a renamed board, so finished or human-held work could be moved backward to replan.
 * Resolution stays async and centralized because every caller already performs a task read before this
 * check, while a lane parameter would duplicate policy across four call sites.
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
  const action = decision.shouldRetry ? "retry-in-place" : "park-failed";

  await emitBoundedRunAudit(deps.store, {
    taskId: task.id,
    agentId: "executor",
    runId: context?.runId ?? generateSyntheticRunId("required-artifact-missing", task.id),
    domain: "database",
    mutationType: "task:required-artifact-missing",
    target: task.id,
    metadata: {
      taskId: task.id,
      artifactKeys,
      owner: "execution",
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

  await deps.store.logEntry(
    task.id,
    `Required workflow artifact missing — retrying repair in ${task.column} (attempt ${attempt}/${MAX_RECOVERY_RETRIES} in ${formatDelay(decision.delayMs)})`,
    `Missing artifact keys: ${artifactKeys.join(", ")}`,
    context,
  );
  const liveTask = await deps.store.getTask(task.id).catch(() => null);
  if (!liveTask || await deps.isRequiredArtifactRecoveryProtected(liveTask)) return;
  await deps.store.updateTask(task.id, {
    status: null,
    error: null,
    recoveryRetryCount: decision.nextState.recoveryRetryCount,
    nextRecoveryAt: decision.nextState.nextRecoveryAt,
    graphResumeRetryCount: 0,
  }, context);
}
