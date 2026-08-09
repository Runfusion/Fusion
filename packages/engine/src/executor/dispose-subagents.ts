/**
 * FNXC:CodeOrganization 2026-08-03-20:45:
 * disposeSubagentsForTask peeled from TaskExecutor (U4).
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { executorLog } from "../logger.js";

export function disposeSubagentsForTask(
  activeSubagentSessions: Map<string, Set<AgentSession>>,
  taskId: string,
  reason: string,
): void {
  const set = activeSubagentSessions.get(taskId);
  if (!set || set.size === 0) return;
  executorLog.log(`${taskId}: disposing ${set.size} subagent session(s) — ${reason}`);
  for (const session of set) {
    try {
      session.dispose();
    } catch (err) {
      executorLog.warn(`${taskId}: failed to dispose subagent session: ${err}`);
    }
  }
  activeSubagentSessions.delete(taskId);
}
