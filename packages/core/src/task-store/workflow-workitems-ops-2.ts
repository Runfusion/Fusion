/**
 * workflow-workitems-ops-2 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore} from "../store.js";
import * as schema from "../postgres/schema/index.js";
import {and, eq, inArray, isNull, like, lt, or} from "drizzle-orm";
import type {WorkflowWorkItem, WorkflowWorkItemState, WorkflowWorkItemTransitionPatch, WorkflowWorkItemUpsertInput} from "../types.js";
import "../builtin-traits.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {replaceActiveTaskWorkflowContinuation as replaceActiveTaskWorkflowContinuationAsync, seedStrandedPlanReviewContinuation as seedStrandedPlanReviewContinuationAsync, upsertWorkflowWorkItem as upsertWorkflowWorkItemAsync, transitionWorkflowWorkItem as transitionWorkflowWorkItemAsync, getWorkflowWorkItem as getWorkflowWorkItemAsync, withTaskWorkflowSerialization} from "../task-store/async/async-workflow-workitems.js";
import { projectScopeFor, type DbTransaction } from "../postgres/data-layer.js";

export async function upsertWorkflowWorkItemImpl(store: TaskStore, input: WorkflowWorkItemUpsertInput, tx?: DbTransaction): Promise<WorkflowWorkItem> {
    return upsertWorkflowWorkItemAsync(store.asyncLayer!, input, tx);
}

export async function replaceActiveTaskWorkflowContinuationImpl(
  store: TaskStore,
  input: WorkflowWorkItemUpsertInput & { kind: "task" },
): Promise<WorkflowWorkItem> {
    return replaceActiveTaskWorkflowContinuationAsync(store.asyncLayer!, input);
}

export async function seedStrandedPlanReviewContinuationImpl(store: TaskStore, input: WorkflowWorkItemUpsertInput & { kind: "task" }): Promise<{ seeded: boolean; reason?: "active-continuation" | "plan-review-passed"; workItemId?: string }> {
  /*
  FNXC:SqliteDualPathCleanup 2026-07-26-14:07:
  Stranded plan-review continuation seed is PostgreSQL-only (withTaskWorkflowSerialization). The SQLite transactionImmediate fallback is deleted.
  */
  return seedStrandedPlanReviewContinuationAsync(store.asyncLayer!, input);
}

export async function transitionWorkflowWorkItemImpl(store: TaskStore, id: string, state: WorkflowWorkItemState, patch: WorkflowWorkItemTransitionPatch = {}, tx?: DbTransaction,): Promise<WorkflowWorkItem> {
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-14:07:
    Workflow work-item transitions are PostgreSQL-only.
    */
    return transitionWorkflowWorkItemAsync(store.asyncLayer!, id, state, patch, tx);
  }

export async function acquireWorkflowWorkItemLeaseImpl(store: TaskStore, id: string, leaseOwner: string, opts: { leaseDurationMs: number; now?: string },): Promise<WorkflowWorkItem | null> {
    if (opts.leaseDurationMs <= 0) {
      throw new Error(`workflow work item leaseDurationMs must be > 0 (received ${opts.leaseDurationMs})`);
    }

    // No dedicated async helper; use a raw Drizzle UPDATE in backend mode.
        const layer = store.asyncLayer!;
    const now = opts.now ?? new Date().toISOString();
    const leaseExpiresAt = new Date(new Date(now).getTime() + opts.leaseDurationMs).toISOString();
    /*
    FNXC:WorkflowSerialization 2026-07-27-00:15:
    Claiming a due item changes it into the active `running` state, so it is
    an FN-8592 protected writer too. Resolve its owner and take the shared
    task lock before the guarded update; otherwise a lease could land between
    conditional repair's idle check and insert.
    */
    const updated = await layer.transactionImmediate(async (tx) => {
      const owner = await getWorkflowWorkItemAsync(tx, id, layer.projectId);
      if (!owner) return null;
      return withTaskWorkflowSerialization(tx, layer.projectId, owner.taskId, async () => {
        /*
        FNXC:WorkflowAgentRouting 2026-08-07-07:02:
        Availability holds must be claimable after an operator restores the named
        principal or pool capacity. Only workflow-principal holds re-enter the
        scheduler; generic/manual holds remain inert until their own lifecycle
        releases them. Every claim predicate carries project_id because work-item
        IDs are only unique within a project.
        */
        await tx
          .update(schema.project.workflowWorkItems)
          .set({ state: "running", leaseOwner, leaseExpiresAt, updatedAt: now })
          .where(and(
            eq(schema.project.workflowWorkItems.id, id),
            projectScopeFor(schema.project.workflowWorkItems.projectId, layer.projectId),
            or(
              inArray(schema.project.workflowWorkItems.state, ["runnable", "retrying"]),
              and(
                eq(schema.project.workflowWorkItems.state, "held"),
                or(
                  like(schema.project.workflowWorkItems.blockedReason, "workflow-principal-%"),
                  like(schema.project.workflowWorkItems.blockedReason, "workflow-named-principal-%"),
                  like(schema.project.workflowWorkItems.blockedReason, "workflow-role-pool-%"),
                ),
              ),
              and(
                eq(schema.project.workflowWorkItems.state, "running"),
                or(
                  isNull(schema.project.workflowWorkItems.leaseExpiresAt),
                  lt(schema.project.workflowWorkItems.leaseExpiresAt, now),
                ),
              ),
            ),
          ));
        const claimed = await getWorkflowWorkItemAsync(tx, id, layer.projectId);
        return claimed?.leaseOwner === leaseOwner ? claimed : null;
      });
    });
    if (!updated) return null;
    // Record the audit event (fire-and-forget).
    void store.recordRunAuditEvent({
      taskId: updated.taskId,
      agentId: "system",
      runId: updated.runId,
      domain: "database",
      mutationType: "workflowWorkItem:lease-acquired",
      target: updated.id,
      metadata: { id: updated.id, leaseOwner: updated.leaseOwner, leaseExpiresAt },
    });
    return updated;
}
