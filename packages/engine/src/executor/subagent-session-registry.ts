/**
 * FNXC:CodeOrganization 2026-08-03-19:00:
 * registerSubagentSession / unregisterSubagentSession peeled from TaskExecutor (U4).
 *
 * Track reviewer (and other) subagent sessions under a parent task so they can be disposed
 * when the parent stops; natural finish only deregisters.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export function registerSubagentSession(
  activeSubagentSessions: Map<string, Set<AgentSession>>,
  taskId: string,
  session: AgentSession,
): void {
  let set = activeSubagentSessions.get(taskId);
  if (!set) {
    set = new Set();
    activeSubagentSessions.set(taskId, set);
  }
  set.add(session);
}

export function unregisterSubagentSession(
  activeSubagentSessions: Map<string, Set<AgentSession>>,
  taskId: string,
  session: AgentSession,
): void {
  const set = activeSubagentSessions.get(taskId);
  if (!set) return;
  set.delete(session);
  if (set.size === 0) activeSubagentSessions.delete(taskId);
}
