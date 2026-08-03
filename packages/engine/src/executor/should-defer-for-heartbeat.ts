/**
 * FNXC:CodeOrganization 2026-08-03-09:25:
 * shouldDeferForHeartbeat peeled from TaskExecutor (U4).
 * Returns true when execute() should wait because a permanent agent has an
 * active heartbeat run and allowParallelExecution=false.
 */
import type { Agent, AgentHeartbeatConfig, AgentStore } from "@fusion/core";
import { isEphemeralAgent } from "@fusion/core";

export type ShouldDeferForHeartbeatDeps = {
  agentStore?: AgentStore | null;
};

export async function shouldDeferForHeartbeat(
  deps: ShouldDeferForHeartbeatDeps,
  agentId: string,
): Promise<boolean> {
  if (!deps.agentStore) return false;
  const agent = await deps.agentStore.getAgent(agentId).catch(() => null) as Agent | null;
  if (!agent) return false;
  if (isEphemeralAgent(agent)) return false;
  const rc = (agent.runtimeConfig ?? {}) as AgentHeartbeatConfig;
  if (rc.allowParallelExecution !== false) return false;
  const activeRun = await deps.agentStore.getActiveHeartbeatRun(agentId).catch(() => null);
  return activeRun !== null;
}
