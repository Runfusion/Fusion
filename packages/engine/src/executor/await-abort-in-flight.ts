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
 *
 * FNXC:StuckSessionOwnership 2026-09-07-17:15:
 * Forced stuck replacement prepares a synchronous interrupt only after reserving the execution FIFO.
 * Its task-keyed claims, asynchronous settlement, and final cleanup then run inside that reservation,
 * so they cannot overlap an already-entered unwind or erase state installed by a successor.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { executorLog } from "../logger.js";
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";

export type AwaitAbortInFlightTaskWorkDeps = {
  userCanceledTaskIds: Set<string>;
  markPausedAborted: (taskId: string, provenance: PausedAbortProvenance, source: string, options?: { quiet?: boolean }) => void;
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

export interface PreparedAbortInFlightTaskWork {
  complete(): Promise<void>;
}

type AbortOptions = {
  userCanceled?: boolean;
  /** Forced replacement reserves the execution FIFO before deferring task-keyed claims. */
  deferTaskKeyedClaims?: boolean;
};

function promiseFromSignal(signal: () => Promise<void>, warning: string): Promise<void> {
  try {
    return signal().catch((error) => executorLog.warn(`${warning}: ${error}`));
  } catch (error) {
    executorLog.warn(`${warning}: ${error}`);
    return Promise.resolve();
  }
}

export function prepareAbortInFlightTaskWork(
  deps: AwaitAbortInFlightTaskWorkDeps,
  taskId: string,
  reason: string,
  options: AbortOptions = {},
): PreparedAbortInFlightTaskWork {
  let hadActiveSurface = false;
  const abortedSurfaces: string[] = [];
  const abortProvenance = options.userCanceled ? "hard-cancel" : "engine-abort";
  const abortSource = `abort-in-flight:${reason}`;

  const claimedSession = deps.activeSessions.get(taskId);
  const claimedStepExecutor = deps.activeStepExecutors.get(taskId);
  const claimedWorkflowSession = deps.activeWorkflowStepSessions.get(taskId);
  const claimedConfiguredCommands = deps.activeConfiguredCommandControllers.get(taskId);
  const claimedWorkflowGraphController = deps.activeWorkflowGraphAbortControllers.get(taskId);
  const claimedSubagents = deps.activeSubagentSessions.has(taskId);
  const claimedCliSession = deps.activeCliTaskSessions.get(taskId);

  if (claimedSession) abortedSurfaces.push("agent-session");
  if (claimedStepExecutor) abortedSurfaces.push("step-session");
  if (claimedWorkflowSession) abortedSurfaces.push("workflow-step-session");
  if (claimedConfiguredCommands?.size) abortedSurfaces.push(`configured-command:${claimedConfiguredCommands.size}`);
  if (claimedWorkflowGraphController) abortedSurfaces.push("workflow-graph");
  if (claimedSubagents) abortedSurfaces.push("subagent-session");
  if (claimedCliSession) abortedSurfaces.push("cli-agent-session");
  hadActiveSurface = abortedSurfaces.length > 0;

  const claimTaskKeyedState = (): void => {
    if (options.userCanceled) deps.userCanceledTaskIds.add(taskId);
    deps.markPausedAborted(taskId, abortProvenance, abortSource, { quiet: true });
    deps.untrackStuckTask(taskId);
    deps.clearWorkflowRerunWatchdog(taskId);
    deps.clearCompletedTaskWatchdog(taskId);
    deps.processWideGraphRouting.delete(taskId);

    if (claimedSession && deps.activeSessions.get(taskId) === claimedSession) {
      deps.deleteActiveSession(taskId);
    }
    if (claimedStepExecutor && deps.activeStepExecutors.get(taskId) === claimedStepExecutor) {
      deps.deleteActiveStepExecutor(taskId);
    }
    if (claimedWorkflowSession && deps.activeWorkflowStepSessions.get(taskId) === claimedWorkflowSession) {
      deps.deleteActiveWorkflowStepSession(taskId);
    }
    if (claimedConfiguredCommands && deps.activeConfiguredCommandControllers.get(taskId) === claimedConfiguredCommands) {
      deps.activeConfiguredCommandControllers.delete(taskId);
    }
    if (claimedWorkflowGraphController && deps.activeWorkflowGraphAbortControllers.get(taskId) === claimedWorkflowGraphController) {
      deps.activeWorkflowGraphAbortControllers.delete(taskId);
    }
    if (claimedCliSession && deps.activeCliTaskSessions.get(taskId) === claimedCliSession) {
      deps.activeCliTaskSessions.delete(taskId);
    }
  };

  if (!options.deferTaskKeyedClaims) claimTaskKeyedState();

  // Interruption is issued synchronously. In forced replacement the FIFO reservation already exists,
  // but task-keyed deletion waits for complete() after the prior owner has settled.
  const sessionAbort = claimedSession && typeof (claimedSession.session as AgentSession & { abort?: () => Promise<void> }).abort === "function"
    ? promiseFromSignal(
      () => (claimedSession.session as AgentSession & { abort: () => Promise<void> }).abort(),
      `Failed to abort agent session for ${taskId}`,
    )
    : Promise.resolve();

  if (claimedStepExecutor?.abortAllSessionBash) {
    try {
      claimedStepExecutor.abortAllSessionBash();
    } catch (error) {
      executorLog.warn(`Failed to abort step-session bash for ${taskId}: ${error}`);
    }
  }
  const stepAbort = claimedStepExecutor
    ? promiseFromSignal(
      () => claimedStepExecutor.terminateAllSessions(),
      `Failed to terminate step sessions for ${taskId}`,
    )
    : Promise.resolve();

  const workflowAbort = claimedWorkflowSession && typeof (claimedWorkflowSession as AgentSession & { abort?: () => Promise<void> }).abort === "function"
    ? promiseFromSignal(
      () => (claimedWorkflowSession as AgentSession & { abort: () => Promise<void> }).abort(),
      `Failed to abort workflow step session for ${taskId}`,
    )
    : Promise.resolve();

  if (claimedConfiguredCommands) {
    for (const controller of claimedConfiguredCommands) controller.abort();
  }
  claimedWorkflowGraphController?.abort();
  if (claimedSubagents) deps.disposeSubagentsForTask(taskId, reason);
  const cliAbort = claimedCliSession
    ? promiseFromSignal(() => claimedCliSession.kill("killed"), `Failed to kill CLI agent session for ${taskId}`)
    : Promise.resolve();

  let completed = false;
  return {
    async complete(): Promise<void> {
      if (completed) return;
      completed = true;
      if (options.deferTaskKeyedClaims) claimTaskKeyedState();

      await sessionAbort;
      if (claimedSession) {
        try {
          claimedSession.session.dispose();
        } catch (error) {
          executorLog.warn(`Failed to dispose agent session for ${taskId}: ${error}`);
        }
      }
      await stepAbort;
      await workflowAbort;
      if (claimedWorkflowSession) {
        try {
          claimedWorkflowSession.dispose();
        } catch (error) {
          executorLog.warn(`Failed to dispose workflow step session for ${taskId}: ${error}`);
        }
      }
      await cliAbort;

      deps.loopRecoveryState.delete(taskId);
      deps.stuckAborted.delete(taskId);

      if (hadActiveSurface) {
        deps.safeLogEntry(taskId, `Pause abort marked: provenance=${abortProvenance} source=${abortSource}`);
        executorLog.log(`${taskId}: awaited abort of in-flight work — ${reason}`);
        deps.safeLogEntry(
          taskId,
          `Pause abort cleanup completed: reason=${reason}; surfaces=${abortedSurfaces.join(", ") || "none"}`,
        );
      }
    },
  };
}

export async function awaitAbortInFlightTaskWork(
  deps: AwaitAbortInFlightTaskWorkDeps,
  taskId: string,
  reason: string,
  options: { userCanceled?: boolean } = {},
): Promise<void> {
  await prepareAbortInFlightTaskWork(deps, taskId, reason, options).complete();
}
