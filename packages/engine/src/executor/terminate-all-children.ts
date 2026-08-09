/**
 * FNXC:CodeOrganization 2026-08-03-18:30:
 * terminateAllChildren peeled from TaskExecutor (U4).
 *
 * Terminate all child agents spawned by a parent task. Detach the parent generation
 * before any agent-store await so a replacement execution cannot have its child set deleted.
 */
import { executorLog } from "../logger.js";

export type TerminateAllChildrenDeps = {
  spawnedAgents: Map<string, Set<string>>;
  terminateChildAgent: (childId: string) => Promise<void>;
};

export async function terminateAllChildren(
  deps: TerminateAllChildrenDeps,
  parentTaskId: string,
): Promise<void> {
  const childIds = deps.spawnedAgents.get(parentTaskId);
  if (!childIds || childIds.size === 0) return;

  executorLog.log(`Terminating ${childIds.size} child agents for parent ${parentTaskId}`);
  // Detach the parent generation before any agent-store await. A replacement
  // execution may register a new set for the same task ID while cleanup is
  // still settling; the old generation must never delete that new set.
  deps.spawnedAgents.delete(parentTaskId);
  await Promise.all([...childIds].map((childId) => deps.terminateChildAgent(childId)));
}
