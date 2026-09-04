import type { TaskStore, RunMutationContext } from "@fusion/core";
import { emitBoundedRunAudit } from "./emit-bounded-run-audit.js";
import { generateSyntheticRunId } from "../util/run-audit.js";

export type StepSessionAbortTrigger =
  | "graceful-pause-abort"
  | "step-failure"
  | "pause-abort"
  | "session-failure";

export type StepSessionAbortRecoveryOutcome =
  | "resumed-in-place"
  | "held-paused"
  | "held-engine-paused";

export type RecoverAbortedStepSessionDeps = {
  store: TaskStore;
  markGraphExecuteSelfRequeued: (taskId: string) => void;
  getRunContextFor: (taskId: string) => RunMutationContext | undefined;
};

/**
 * FNXC:LifecycleContainment 2026-09-04-03:04:
 * Rule F5 forbids a WIP-to-hold move for every recovery reason except plan-review-revise-replan.
 * Optionless moves previously escaped only because lifecycle postcondition evaluation fails open for
 * non-engine sources, so aborted step sessions must retain their existing lane and progress.
 */
export async function recoverAbortedStepSessionInPlace(
  deps: RecoverAbortedStepSessionDeps,
  taskId: string,
  trigger: StepSessionAbortTrigger,
  detail?: string,
): Promise<StepSessionAbortRecoveryOutcome> {
  const live = await deps.store.getTask(taskId);
  const completedStepCount = live.steps?.filter((step) => step.status === "done").length ?? 0;

  let outcome: StepSessionAbortRecoveryOutcome;
  if (live.paused || live.userPaused) {
    outcome = "held-paused";
  } else {
    await deps.store.updateTask(taskId, { status: null, error: null });
    await deps.store.logEntry(
      taskId,
      `Step-session ${trigger} repaired in place; resuming the same node and step${detail ? ` (${detail})` : ""}`,
      undefined,
      deps.getRunContextFor(taskId),
    );
    deps.markGraphExecuteSelfRequeued(taskId);
    const settings = await deps.store.getSettings();
    outcome = settings.globalPause || settings.enginePaused
      ? "held-engine-paused"
      : "resumed-in-place";
  }

  // Telemetry is deliberately detached so a hostile audit sink cannot delay same-node recovery.
  void emitBoundedRunAudit(deps.store, {
    taskId,
    agentId: "executor",
    runId: deps.getRunContextFor(taskId)?.runId ?? generateSyntheticRunId("step-session-abort", taskId),
    domain: "database",
    mutationType: "task:step-session-abort-contained",
    target: taskId,
    metadata: { taskId, column: live.column, trigger, outcome, completedStepCount },
  });

  return outcome;
}
