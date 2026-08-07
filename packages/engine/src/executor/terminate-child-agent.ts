/**
 * FNXC:CodeOrganization 2026-08-03-17:00:
 * terminateChildAgent peeled from TaskExecutor (U4).
 *
 * Dispose a spawned child session, park/delete the ephemeral agent, and decrement spawn count.
 */
import type { AgentStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import { isBenignEphemeralDeleteRaceError } from "./ephemeral-delete-race.js";

export type TerminateChildAgentDeps = {
  options: { agentStore?: AgentStore | null; [k: string]: unknown };
  childSessions: Map<string, { dispose: () => void }>;
  pendingEphemeralDeletions: Set<string>;
  totalSpawnedCount: number;
  setTotalSpawnedCount: (n: number) => void;
};

export async function terminateChildAgent(
  deps: TerminateChildAgentDeps,
  childId: string,
): Promise<void> {
  const childSession = deps.childSessions.get(childId);
  if (childSession) {
    childSession.dispose();
    deps.childSessions.delete(childId);
  }

  try {
    await deps.options.agentStore?.updateAgentState(childId, "paused");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    executorLog.warn(`Failed to update spawned child ${childId} state to 'terminated' during cleanup: ${msg}`);
  }

  deps.pendingEphemeralDeletions.add(childId);
  try {
    await deps.options.agentStore?.deleteAgent(childId);
  } catch (err: unknown) {
    if (!isBenignEphemeralDeleteRaceError(childId, err)) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`Failed to delete spawned agent ${childId}: ${msg}`);
    }
  } finally {
    deps.pendingEphemeralDeletions.delete(childId);
  }

  deps.setTotalSpawnedCount(Math.max(0, deps.totalSpawnedCount - 1));
}
