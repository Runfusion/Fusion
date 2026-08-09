/**
 * FNXC:CodeOrganization 2026-08-03-17:00:
 * runWithExecutorSemaphore peeled from TaskExecutor (U4).
 *
 * FNXC:GlobalConcurrencyControls 2026-07-14-18:30:
 * Prefer a scheduler pre-held global slot when present so hold/release tryAcquire and the
 * executor share one top-level claim. Nested seam/step sessions must not acquire again under
 * an active outer claim (deadlock under a full global cap).
 */
import {
  PRIORITY_EXECUTE,
  takePreHeldExecutorSlot,
  type AgentSemaphore,
} from "../concurrency/concurrency.js";

export type RunWithExecutorSemaphoreDeps = {
  options: { semaphore?: AgentSemaphore; [k: string]: unknown };
  outerConcurrencyClaims: Set<string>;
};

export async function runWithExecutorSemaphore<T>(
  deps: RunWithExecutorSemaphoreDeps,
  taskId: string,
  work: () => Promise<T>,
): Promise<T> {
  const sem = deps.options.semaphore;
  if (!sem) {
    takePreHeldExecutorSlot(taskId);
    return work();
  }
  if (deps.outerConcurrencyClaims.has(taskId)) {
    return work();
  }

  const runUnderOuterClaim = async (): Promise<T> => {
    deps.outerConcurrencyClaims.add(taskId);
    try {
      return await work();
    } finally {
      deps.outerConcurrencyClaims.delete(taskId);
    }
  };

  if (takePreHeldExecutorSlot(taskId)) {
    try {
      return await runUnderOuterClaim();
    } finally {
      sem.release();
    }
  }
  return sem.run(runUnderOuterClaim, PRIORITY_EXECUTE);
}
