/**
 * FNXC:CodeOrganization 2026-08-03-17:00:
 * abortAllSessionBash peeled from TaskExecutor (U4).
 *
 * Best-effort abort of bash tools across coding sessions, spawned children, and step executors.
 */
import { executorLog } from "../logger.js";

export type AbortAllSessionBashDeps = {
  activeSessions: Map<string, { session: { abortBash: () => void } }>;
  childSessions: Map<string, { abortBash: () => void }>;
  activeStepExecutors: Map<string, { abortAllSessionBash: () => void }>;
};

export function abortAllSessionBash(deps: AbortAllSessionBashDeps): void {
  for (const [taskId, { session }] of deps.activeSessions) {
    try {
      session.abortBash();
    } catch (err) {
      executorLog.warn(`abortAllSessionBash: failed for task ${taskId}: ${err}`);
    }
  }
  for (const [agentId, session] of deps.childSessions) {
    try {
      session.abortBash();
    } catch (err) {
      executorLog.warn(`abortAllSessionBash: failed for child agent ${agentId}: ${err}`);
    }
  }
  for (const [taskId, stepExecutor] of deps.activeStepExecutors) {
    try {
      stepExecutor.abortAllSessionBash();
    } catch (err) {
      executorLog.warn(`abortAllSessionBash: failed for step executor ${taskId}: ${err}`);
    }
  }
}
