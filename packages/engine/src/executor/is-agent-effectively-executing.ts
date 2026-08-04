/**
 * FNXC:CodeOrganization 2026-08-03-20:15:
 * isAgentEffectivelyExecuting peeled from TaskExecutor (U4).
 *
 * Column-agent principal alignment (plan U5, R6). True when agentId is the EFFECTIVE
 * column-agent principal currently running some executing task's coding/step session.
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
