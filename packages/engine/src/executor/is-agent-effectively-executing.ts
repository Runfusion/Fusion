/**
 * FNXC:CodeOrganization 2026-08-03-20:15:
 * isAgentEffectivelyExecuting peeled from TaskExecutor (U4).
 *
 * FNXC:ColumnAgent 2026-07-19 (plan U5, R6):
 * True when `agentId` is the EFFECTIVE column-agent principal currently running some
 * executing task's coding/step session — i.e. an override/defer-bound column staffs it,
 * even though the agent is not the task's `assignedAgentId`. Injected into the heartbeat
 * scheduler's reverse-direction parallel-execution guards so an `allowParallelExecution=false`
 * column agent does not heartbeat concurrently with its own override session. Returns false
 * for the legacy/no-binding path (the map is empty), preserving prior behavior exactly.
 */
export function isAgentEffectivelyExecuting(
  effectiveColumnAgentByTask: Map<string, string>,
  agentId: string,
): boolean {
  if (!agentId) return false;
  for (const effectiveId of effectiveColumnAgentByTask.values()) {
    if (effectiveId === agentId) return true;
  }
  return false;
}
