/**
 * FNXC:CodeOrganization 2026-08-03-20:15:
 * isEphemeralDeletionPending / disposeEphemeralTimers peeled from TaskExecutor (U4).
 */
export function isEphemeralDeletionPending(
  pendingEphemeralDeletions: Set<string>,
  agentId: string,
): boolean {
  return pendingEphemeralDeletions.has(agentId);
}

export function disposeEphemeralTimers(
  pendingEphemeralDeletions: Set<string>,
): void {
  pendingEphemeralDeletions.clear();
}
