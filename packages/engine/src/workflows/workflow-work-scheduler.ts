import type { AsyncMissionStore, MissionStore, Task, WorkflowWorkItem, WorkflowWorkItemDueFilter, WorkflowWorkItemKind } from "@fusion/core";
import { decideMissionSymbolAdmission } from "../missions/mission-symbol-admission.js";

const WORKFLOW_SYMBOL_LOCK_LEASE_MS = 10 * 60_000;

export interface WorkflowWorkSchedulerStore {
  listDueWorkflowWorkItems(filter?: WorkflowWorkItemDueFilter): WorkflowWorkItem[];
  acquireWorkflowWorkItemLease(
    id: string,
    leaseOwner: string,
    opts: { leaseDurationMs: number; now?: string },
  ): WorkflowWorkItem | null;
  /** TaskStore supplies these optional scheduler-admission capabilities. */
  getTask?(id: string): Promise<Task | undefined>;
  getMissionStore?(): MissionStore | AsyncMissionStore;
  getSettings?(): Promise<{ planApprovalMode?: "workflow" | "auto-approve-all" | "require-all" }>;
  acquireSymbolLocks?(
    symbols: readonly string[],
    owner: { ownerTaskId: string; missionId?: string; featureId?: string; agentId?: string },
    leaseMs: number,
  ): Promise<{ acquired: true; conflicts: [] } | { acquired: false; conflicts: Array<{ symbolKey: string; ownerTaskId: string }> }>;
  releaseSymbolLocks?(symbols: readonly string[], ownerTaskId: string): Promise<unknown>;
  renewSymbolLocks?(symbols: readonly string[], ownerTaskId: string, leaseMs: number): Promise<{ renewed: string[]; lost: string[] }>;
  logEntry?(taskId: string, message: string): Promise<unknown>;
}

export interface WorkflowWorkDispatch {
  workItem: WorkflowWorkItem;
  runId: string;
  taskId: string;
  nodeId: string;
  /** Symbols held by this claim; the processor renews them while runtime work is live. */
  symbolLocks?: string[];
}

export interface ClaimWorkflowWorkOptions {
  now?: string;
  limit?: number;
  leaseOwner: string;
  leaseDurationMs: number;
  kinds?: WorkflowWorkItemKind[];
}

/**
 * FNXC:MissionSymbolAdmission 2026-07-31-12:00:
 * Workflow work claiming is async because durable symbol acquisition must occur
 * before its work lease is consumed. Unapproved mission work and contention are
 * skipped without a lease, while deployments without the TaskStore admission
 * seam retain their existing coarse workflow-lease behavior.
 */
export async function claimDueWorkflowWorkItem(
  store: WorkflowWorkSchedulerStore,
  opts: ClaimWorkflowWorkOptions,
): Promise<WorkflowWorkDispatch | null> {
  const due = store.listDueWorkflowWorkItems({
    now: opts.now,
    limit: opts.limit ?? 25,
    kinds: opts.kinds,
  });

  for (const candidate of due) {
    const task = store.getTask ? await store.getTask(candidate.taskId) : undefined;
    let lockedSymbols: string[] | undefined;
    if (task && store.getMissionStore && store.acquireSymbolLocks) {
      const settings = await store.getSettings?.();
      const admission = await decideMissionSymbolAdmission(task, store.getMissionStore(), {
        planApprovalRequired: settings?.planApprovalMode === "require-all",
      });
      if (admission.kind === "lineage-blocked") {
        await store.logEntry?.(task.id, `workflow work not claimed — mission lineage blocked: ${admission.reason}`);
        continue;
      }
      if (admission.kind === "symbol-lock") {
        const result = await store.acquireSymbolLocks(
          admission.symbols,
          { ownerTaskId: task.id, missionId: task.missionId, featureId: admission.feature.id, agentId: opts.leaseOwner },
          WORKFLOW_SYMBOL_LOCK_LEASE_MS,
        );
        if (!result.acquired) {
          const conflict = result.conflicts[0];
          await store.logEntry?.(task.id, `workflow work not claimed — symbol contention: symbol=${conflict?.symbolKey ?? "unknown"} holder=${conflict?.ownerTaskId ?? "unknown"}`);
          continue;
        }
        lockedSymbols = admission.symbols;
      }
    }

    const workItem = store.acquireWorkflowWorkItemLease(candidate.id, opts.leaseOwner, {
      now: opts.now,
      leaseDurationMs: opts.leaseDurationMs,
    });
    if (!workItem) {
      if (lockedSymbols) await store.releaseSymbolLocks?.(lockedSymbols, candidate.taskId);
      continue;
    }
    return {
      workItem,
      runId: workItem.runId,
      taskId: workItem.taskId,
      nodeId: workItem.nodeId,
      symbolLocks: lockedSymbols,
    };
  }

  return null;
}
