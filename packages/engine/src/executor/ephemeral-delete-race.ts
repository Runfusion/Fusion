/**
 * FNXC:CodeOrganization 2026-08-03-13:35:
 * Pure ephemeral agent delete-race classifier peeled from TaskExecutor (U4).
 */
import { executorLog } from "../logger.js";

export function isBenignEphemeralDeleteRaceError(agentId: string, err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("not found") || lower.includes("already deleted") || lower.includes("does not exist")) {
    executorLog.debug(`Skip spawned-agent cleanup for ${agentId}: already deleted by another pathway`);
    return true;
  }
  return false;
}
