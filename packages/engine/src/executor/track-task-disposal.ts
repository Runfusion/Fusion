/**
 * FNXC:CodeOrganization 2026-08-03-18:00:
 * trackTaskDisposal peeled from TaskExecutor (U4).
 *
 * FN-5256: register an in-flight disposal so a subsequent dispatch can await it
 * before acquiring/creating a worktree. Errors are swallowed into the executor log.
 */
import { executorLog } from "../logger.js";

export type TrackTaskDisposalDeps = {
  pendingTaskDisposals: Map<string, Promise<void>>;
};

export function trackTaskDisposal(
  deps: TrackTaskDisposalDeps,
  taskId: string,
  disposal: Promise<void>,
): void {
  const wrapped = disposal
    .catch((err) => {
      executorLog.warn(`${taskId}: tracked disposal failed: ${err}`);
    })
    .finally(() => {
      if (deps.pendingTaskDisposals.get(taskId) === wrapped) {
        deps.pendingTaskDisposals.delete(taskId);
      }
    });
  deps.pendingTaskDisposals.set(taskId, wrapped);
}
