/**
 * FNXC:CodeOrganization 2026-08-03-11:10:
 * abortAllInFlight peeled from TaskExecutor (U4).
 * Runtime shutdown / broad abort: every task surface + child sessions.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { executorLog } from "../logger.js";

export type AbortAllInFlightDeps = {
  activeSessions: Map<string, unknown>;
  activeStepExecutors: Map<string, unknown>;
  activeWorkflowStepSessions: Map<string, unknown>;
  activeConfiguredCommandControllers: Map<string, unknown>;
  activeWorkflowGraphAbortControllers: Map<string, unknown>;
  activeSubagentSessions: Map<string, unknown>;
  activeCliTaskSessions: Map<string, unknown>;
  childSessions: Map<string, AgentSession>;
  awaitAbortInFlightTaskWork: (taskId: string, reason: string) => Promise<void>;
};

export async function abortAllInFlight(
  deps: AbortAllInFlightDeps,
  reason: string,
): Promise<void> {
  const taskIds = new Set<string>([
    ...deps.activeSessions.keys(),
    ...deps.activeStepExecutors.keys(),
    ...deps.activeWorkflowStepSessions.keys(),
    ...deps.activeConfiguredCommandControllers.keys(),
    ...deps.activeWorkflowGraphAbortControllers.keys(),
    ...deps.activeSubagentSessions.keys(),
    ...deps.activeCliTaskSessions.keys(),
  ]);

  for (const taskId of taskIds) {
    try {
      await deps.awaitAbortInFlightTaskWork(taskId, reason);
    } catch (err) {
      executorLog.warn(`abortAllInFlight: failed to abort task ${taskId} — ${reason}: ${err}`);
    }
  }

  for (const [agentId, session] of deps.childSessions) {
    try {
      const sessionWithAbort = session as AgentSession & { abort?: () => Promise<void> };
      if (typeof sessionWithAbort.abort === "function") {
        await sessionWithAbort.abort();
      }
    } catch (err) {
      executorLog.warn(`abortAllInFlight: failed to abort child session ${agentId} — ${reason}: ${err}`);
    }

    try {
      session.dispose();
    } catch (err) {
      executorLog.warn(`abortAllInFlight: failed to dispose child session ${agentId} — ${reason}: ${err}`);
    }
  }
  deps.childSessions.clear();

  executorLog.log(`abortAllInFlight: aborted ${taskIds.size} task surface(s) — ${reason}`);
}
