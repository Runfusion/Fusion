/**
 * FNXC:CodeOrganization 2026-08-03-11:00:
 * awaitAbortInFlightTaskWork peeled from TaskExecutor (U4).
 * Hard-cancel / pause abort: claim surfaces synchronously, then abort/dispose.
 *
 * FNXC:WorkflowLifecycle 2026-07-26-11:20:
 * KB-PROV: Stamp provenance the caller reported (hard-cancel vs engine-abort), not a blanket hard-cancel.
 *
 * FNXC:WorkflowExecution 2026-07-19-01:30:
 * U5d — no completion-interceptor cleanup; graph-owned signal is call-scoped.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { executorLog } from "../logger.js";
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";

export type AwaitAbortInFlightTaskWorkDeps = {
  userCanceledTaskIds: Set<string>;
  markPausedAborted: (taskId: string, provenance: PausedAbortProvenance, source: string) => void;
  untrackStuckTask: (taskId: string) => void;
  clearWorkflowRerunWatchdog: (taskId: string) => void;
  clearCompletedTaskWatchdog: (taskId: string) => void;
  processWideGraphRouting: Set<string>;
  activeSessions: Map<string, { session: AgentSession }>;
  deleteActiveSession: (taskId: string) => void;
  activeStepExecutors: Map<string, {
    terminateAllSessions(): Promise<void>;
    abortAllSessionBash?: () => void;
  }>;
  deleteActiveStepExecutor: (taskId: string) => void;
  activeWorkflowStepSessions: Map<string, AgentSession>;
  deleteActiveWorkflowStepSession: (taskId: string) => void;
  activeConfiguredCommandControllers: Map<string, Set<AbortController>>;
  activeWorkflowGraphAbortControllers: Map<string, AbortController>;
  activeSubagentSessions: { has(taskId: string): boolean };
  disposeSubagentsForTask: (taskId: string, reason: string) => void;
  activeCliTaskSessions: Map<string, { kill(reason?: string): Promise<void> }>;
  loopRecoveryState: Map<string, unknown>;
  stuckAborted: Map<string, unknown>;
  safeLogEntry: (taskId: string, message: string) => void;
};

export async function awaitAbortInFlightTaskWork(
  deps: AwaitAbortInFlightTaskWorkDeps,
  taskId: string,
  reason: string,
  options: { userCanceled?: boolean } = {},
): Promise<void> {
  let hadActiveSurface = false;
  const abortedSurfaces: string[] = [];

  if (options.userCanceled) {
    deps.userCanceledTaskIds.add(taskId);
  }
  /*
  FNXC:WorkflowLifecycle 2026-07-26-11:20:
  KB-PROV: Stamp the provenance the caller actually reported instead of a blanket `hard-cancel`. `options.userCanceled` is already the truthful operator-intent signal every caller computes (`source === "user"`, soft-delete, the registered move disposer), so derive the label from it: operator withdrawal keeps `hard-cancel`, everything else is an `engine-abort`. Without this, the FN-8596 engine rerun bounce told the operator `provenance=hard-cancel` for work the engine itself re-dispatched, and any future consumer branching on `hard-cancel` would read an engine bounce as an operator withdrawal. Behaviour is unchanged: `userPaused` is still never set by engine rebounds, and the downstream classifiers accept both labels via `isGenericAbortProvenance()`.
  */
  deps.markPausedAborted(taskId, options.userCanceled ? "hard-cancel" : "engine-abort", `abort-in-flight:${reason}`);
  deps.untrackStuckTask(taskId);
  deps.clearWorkflowRerunWatchdog(taskId);
  deps.clearCompletedTaskWatchdog(taskId);
  // Defensive graph-interpreter cleanup: a pause/abort mid-graph must not leave a
  // stale routing claim behind. The graph runner's own finally blocks also clear
  // this; double-delete is harmless.
  // FNXC:WorkflowExecution 2026-07-19-01:30: U5d — there is no completion-interceptor
  // entry to clear anymore. The graph-owned signal is now a call-scoped callback
  // parameter (see GraphCompletionCallback), so it cannot outlive the run that created
  // it and needs no abort-time cleanup.
  deps.processWideGraphRouting.delete(taskId);

  // FN-5256: claim each surface synchronously BEFORE awaiting any async
  // abort. Without this, two concurrent disposal calls for the same task
  // (e.g., task:moved-away followed immediately by task:deleted) both pass
  // the `has(taskId)` guards and double-call abort/dispose.
  const claimedSession = deps.activeSessions.get(taskId);
  if (claimedSession) {
    hadActiveSurface = true;
    abortedSurfaces.push("agent-session");
    deps.deleteActiveSession(taskId);
  }
  const claimedStepExecutor = deps.activeStepExecutors.get(taskId);
  if (claimedStepExecutor) {
    hadActiveSurface = true;
    abortedSurfaces.push("step-session");
    deps.deleteActiveStepExecutor(taskId);
  }
  const claimedWorkflowSession = deps.activeWorkflowStepSessions.get(taskId);
  if (claimedWorkflowSession) {
    hadActiveSurface = true;
    abortedSurfaces.push("workflow-step-session");
    deps.deleteActiveWorkflowStepSession(taskId);
  }
  const claimedConfiguredCommands = deps.activeConfiguredCommandControllers.get(taskId);
  if (claimedConfiguredCommands && claimedConfiguredCommands.size > 0) {
    hadActiveSurface = true;
    abortedSurfaces.push(`configured-command:${claimedConfiguredCommands.size}`);
    deps.activeConfiguredCommandControllers.delete(taskId);
    for (const controller of claimedConfiguredCommands) {
      controller.abort();
    }
  }
  const claimedWorkflowGraphController = deps.activeWorkflowGraphAbortControllers.get(taskId);
  if (claimedWorkflowGraphController) {
    hadActiveSurface = true;
    abortedSurfaces.push("workflow-graph");
    deps.activeWorkflowGraphAbortControllers.delete(taskId);
    claimedWorkflowGraphController.abort();
  }
  const claimedSubagents = deps.activeSubagentSessions.has(taskId);
  if (claimedSubagents) {
    hadActiveSurface = true;
    abortedSurfaces.push("subagent-session");
    deps.disposeSubagentsForTask(taskId, reason);
  }
  // CLI Agent Executor (U7): a cli-agent session is a hard-cancel surface like
  // any API session. Claim it synchronously, then SIGKILL the PTY and mark
  // `killed` (never resume-eligible) — the same dispose/abort contract API
  // sessions honor. moveTask(in-progress→todo) routes here (AGENTS.md hard
  // cancel), so this is what guarantees the PTY tree is reaped on column exit.
  const claimedCliSession = deps.activeCliTaskSessions.get(taskId);
  if (claimedCliSession) {
    hadActiveSurface = true;
    abortedSurfaces.push("cli-agent-session");
    deps.activeCliTaskSessions.delete(taskId);
  }

  if (claimedSession) {
    const { session } = claimedSession;
    const sessionWithAbort = session as AgentSession & { abort?: () => Promise<void> };
    if (typeof sessionWithAbort.abort === "function") {
      await sessionWithAbort.abort().catch((err) => {
        executorLog.warn(`Failed to abort agent session for ${taskId}: ${err}`);
      });
    }
    try {
      session.dispose();
    } catch (err) {
      executorLog.warn(`Failed to dispose agent session for ${taskId}: ${err}`);
    }
  }

  if (claimedStepExecutor) {
    const stepExecutorWithAbort = claimedStepExecutor as { abortAllSessionBash?: () => void; terminateAllSessions(): Promise<void> };
    if (typeof stepExecutorWithAbort.abortAllSessionBash === "function") {
      try {
        stepExecutorWithAbort.abortAllSessionBash();
      } catch (err) {
        executorLog.warn(`Failed to abort step-session bash for ${taskId}: ${err}`);
      }
    }
    await claimedStepExecutor.terminateAllSessions().catch((err) =>
      executorLog.error(`Failed to terminate step sessions for ${taskId}:`, err),
    );
  }

  if (claimedWorkflowSession) {
    const sessionWithAbort = claimedWorkflowSession as AgentSession & { abort?: () => Promise<void> };
    if (typeof sessionWithAbort.abort === "function") {
      await sessionWithAbort.abort().catch((err) => {
        executorLog.warn(`Failed to abort workflow step session for ${taskId}: ${err}`);
      });
    }
    try {
      claimedWorkflowSession.dispose();
    } catch (err) {
      executorLog.warn(`Failed to dispose workflow step session for ${taskId}: ${err}`);
    }
  }

  if (claimedCliSession) {
    await claimedCliSession.kill("killed").catch((err) => {
      executorLog.warn(`Failed to kill CLI agent session for ${taskId}: ${err}`);
    });
  }

  deps.loopRecoveryState.delete(taskId);
  deps.stuckAborted.delete(taskId);

  if (hadActiveSurface) {
    executorLog.log(`${taskId}: awaited abort of in-flight work — ${reason}`);
    deps.safeLogEntry(
      taskId,
      `Pause abort cleanup completed: reason=${reason}; surfaces=${abortedSurfaces.join(", ") || "none"}`,
    );
  }
}
