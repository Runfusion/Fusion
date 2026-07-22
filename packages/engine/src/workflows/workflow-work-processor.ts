import type { Settings, WorkflowWorkItem, WorkflowWorkItemKind, WorkflowWorkItemState } from "@fusion/core";
import { claimDueWorkflowWorkItem, type WorkflowWorkSchedulerStore } from "./workflow-work-scheduler.js";
import { WorkflowTaskRuntime, type WorkflowTaskRuntimeResult } from "./workflow-task-runtime.js";

export interface WorkflowWorkProcessorOptions {
  leaseOwner: string;
  leaseDurationMs: number;
  now?: string;
  kinds?: WorkflowWorkItemKind[];
}

export interface WorkflowWorkProcessorResult {
  claimed: boolean;
  workItemId?: string;
  taskId?: string;
  runtime?: WorkflowTaskRuntimeResult;
}

type WorkflowWorkProcessorStore = WorkflowWorkSchedulerStore & {
  transitionWorkflowWorkItem?: (
    id: string,
    state: WorkflowWorkItemState,
    patch?: { now?: string; lastError?: string | null; leaseOwner?: string | null; leaseExpiresAt?: string | null },
  ) => WorkflowWorkItem;
};

export async function processDueWorkflowWorkItem(
  store: WorkflowWorkProcessorStore,
  runtime: WorkflowTaskRuntime,
  settings: (Pick<Settings, "experimentalFeatures"> & Partial<Settings>) | undefined,
  opts: WorkflowWorkProcessorOptions,
): Promise<WorkflowWorkProcessorResult> {
  /* FNXC:MissionSymbolAdmission 2026-07-31-12:00: await the async symbol-lock admission before runtime may consume the workflow work lease. */
  const dispatch = await claimDueWorkflowWorkItem(store, {
    now: opts.now,
    leaseOwner: opts.leaseOwner,
    leaseDurationMs: opts.leaseDurationMs,
    kinds: opts.kinds,
  });
  if (!dispatch) return { claimed: false };

  let runtimeResult: WorkflowTaskRuntimeResult;
  /*
  FNXC:MissionSymbolAdmission 2026-08-01-01:00:
  Workflow execution can outlive the ten-minute crash-recoverable lease. Renew
  only locks acquired by this claim while its runtime is live; transition release
  remains authoritative once the work reaches review, requeue, or terminal state.
  */
  const renewInterval = dispatch.symbolLocks && store.renewSymbolLocks
    ? setInterval(() => {
      void store.renewSymbolLocks!(dispatch.symbolLocks!, dispatch.taskId, 10 * 60_000)
        .then(async (result) => {
          if (result.lost.length > 0) {
            await store.logEntry?.(dispatch.taskId, `workflow symbol-lock renewal lost: ${result.lost.join(", ")}`);
          }
        })
        .catch(() => undefined);
    }, (10 * 60_000) / 3)
    : undefined;
  try {
    runtimeResult = await runtime.runWorkItem(dispatch.workItem, settings);
  } catch (err) {
    const reason = `workflow-work-item-runtime-error:${err instanceof Error ? err.message : String(err)}`;
    try {
      store.transitionWorkflowWorkItem?.(dispatch.workItem.id, "failed", {
        now: opts.now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: reason,
      });
    } catch {
      // Best-effort cleanup; callers still need the claimed work identity on double-failure.
    }
    runtimeResult = {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: [],
      context: {},
      reason,
    };
  } finally {
    if (renewInterval) clearInterval(renewInterval);
  }
  return {
    claimed: true,
    workItemId: dispatch.workItem.id,
    taskId: dispatch.taskId,
    runtime: runtimeResult,
  };
}

export function workflowMergeWorkKinds(): WorkflowWorkItemKind[] {
  return ["merge", "manual-hold"];
}
