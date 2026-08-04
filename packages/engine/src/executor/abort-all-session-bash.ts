/**
 * FNXC:CodeOrganization 2026-08-03-17:00:
 * abortAllSessionBash peeled from TaskExecutor (U4).
 *
 * Abort the in-flight bash subprocess (if any) on every active agent session.
 * Invoked at runtime shutdown so detached subprocess trees spawned by agent bash
 * tools — including grandchildren like vitest workers — are killed via
 * pi-coding-agent's killProcessTree. Without this, when the worker is killed those
 * process groups are orphaned because they're detached. Sessions are not disposed
 * here so any near-complete agent loop still has a chance to wrap up during the
 * runtime's graceful drain window.
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
