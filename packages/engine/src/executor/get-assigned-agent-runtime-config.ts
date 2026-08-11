/**
 * FNXC:CodeOrganization 2026-08-03-15:40:
 * getAssignedAgentRuntimeConfig peeled from TaskExecutor (U4).
 *
 * Thin lookup: authoritative assigned agent → runtimeConfig bag.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror TaskExecutor method surface
type AnyFn = (...args: any[]) => any;

export type GetAssignedAgentRuntimeConfigDeps = {
  getAuthoritativeAssignedAgent: AnyFn;
};

export async function getAssignedAgentRuntimeConfig(
  deps: GetAssignedAgentRuntimeConfigDeps,
  assignedAgentId: string | null | undefined,
): Promise<Record<string, unknown> | undefined> {
  const agent = await deps.getAuthoritativeAssignedAgent(assignedAgentId);
  return (agent?.runtimeConfig ?? undefined) as Record<string, unknown> | undefined;
}
