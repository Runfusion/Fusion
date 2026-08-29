/**
 * FNXC:CodeOrganization 2026-08-03-17:15:
 * renewTaskLease peeled from TaskExecutor (U4).
 *
 * Renews the agent checkout lease (AgentStore) or store checkout lease metadata.
 */
import type { AgentStore, TaskStore } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";

export type RenewTaskLeaseDeps = {
  store: TaskStore;
  options: { agentStore?: AgentStore | null; [k: string]: unknown };
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export async function renewTaskLease(
  deps: RenewTaskLeaseDeps,
  taskId: string,
  agentId: string,
  leaseEpoch: number,
  nodeId: string,
  runId: string | undefined,
): Promise<void> {
  const renewedAt = new Date().toISOString();
  if (deps.options.agentStore) {
    await deps.options.agentStore.checkoutTask(
      agentId,
      taskId,
      {
        nodeId,
        runId,
        leaseEpoch,
        renewedAt,
      },
      deps.getRunContextFor(taskId),
    );
    return;
  }
  await deps.store.renewCheckoutLease(taskId, {
    checkoutRunId: runId ?? null,
    checkoutLeaseRenewedAt: renewedAt,
  });
}
