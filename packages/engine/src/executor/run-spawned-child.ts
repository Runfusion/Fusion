/**
 * FNXC:CodeOrganization 2026-08-03-11:45:
 * runSpawnedChild peeled from TaskExecutor (U4).
 *
 * FNXC:AgentSpawning 2026-06-23-12:25:
 * Server memory must return to baseline after spawned child execution. Dispose the child session and free spawn budget in finally.
 */
import type { AgentStore } from "@fusion/core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { promptWithFallback } from "../pi.js";
import { executorLog } from "../logger.js";

export type RunSpawnedChildDeps = {
  agentStore?: AgentStore | null;
  childSessions: Map<string, AgentSession>;
  /** Mutable spawn counter owned by TaskExecutor. */
  adjustSpawnedCount: (delta: number) => void;
};

export async function runSpawnedChild(
  deps: RunSpawnedChildDeps,
  agentId: string,
  childSession: AgentSession,
  taskPrompt: string,
): Promise<void> {
  try {
    await deps.agentStore?.updateAgentState(agentId, "running");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    executorLog.warn(`Failed to update spawned child ${agentId} state to 'running': ${msg}`);
  }

  try {
    await promptWithFallback(childSession, taskPrompt);
    // Normal completion — mark as active (available)
    try {
      await deps.agentStore?.updateAgentState(agentId, "active");
    } catch (markActiveErr) {
      executorLog.warn(`Child agent ${agentId} updateAgentState(active) failed: ${markActiveErr instanceof Error ? markActiveErr.message : String(markActiveErr)}`);
    }
  } catch (err: unknown) {
    // Error during execution — mark as error
    try {
      await deps.agentStore?.updateAgentState(agentId, "error");
    } catch (markErrorErr) {
      executorLog.warn(`Child agent ${agentId} updateAgentState(error) failed: ${markErrorErr instanceof Error ? markErrorErr.message : String(markErrorErr)}`);
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    executorLog.warn(`Child agent ${agentId} failed: ${errorMessage}`);
  } finally {
    if (deps.childSessions.get(agentId) === childSession) {
      try {
        await childSession.dispose();
      } catch (disposeErr) {
        executorLog.warn(`Child agent ${agentId} session dispose failed: ${disposeErr instanceof Error ? disposeErr.message : String(disposeErr)}`);
      }
      deps.childSessions.delete(agentId);
    }
    deps.adjustSpawnedCount(-1);
  }
}
