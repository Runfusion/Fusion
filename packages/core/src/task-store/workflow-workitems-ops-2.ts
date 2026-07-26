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
import {randomUUID} from "node:crypto";
import {and, eq, inArray} from "drizzle-orm";
import type {WorkflowWorkItem, WorkflowWorkItemState, WorkflowWorkItemTransitionPatch, WorkflowWorkItemUpsertInput} from "../types.js";
import "../builtin-traits.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {replaceActiveTaskWorkflowContinuation as replaceActiveTaskWorkflowContinuationAsync, seedStrandedPlanReviewContinuation as seedStrandedPlanReviewContinuationAsync, upsertWorkflowWorkItem as upsertWorkflowWorkItemAsync, transitionWorkflowWorkItem as transitionWorkflowWorkItemAsync, getWorkflowWorkItem as getWorkflowWorkItemAsync, withTaskWorkflowSerialization} from "../task-store/async-workflow-workitems.js";
import type {WorkflowWorkItemRow} from "../task-store/row-types.js";
import type {DbTransaction} from "../postgres/data-layer.js";

function upsertWorkflowWorkItemSyncInTransaction(store: TaskStore, input: WorkflowWorkItemUpsertInput): WorkflowWorkItem {
      const existing = store.db
        .prepare("SELECT * FROM workflow_work_items WHERE runId = ? AND taskId = ? AND nodeId = ? AND kind = ?")
        .get(input.runId, input.taskId, input.nodeId, input.kind) as WorkflowWorkItemRow | undefined;
      const now = input.now ?? new Date().toISOString();
      const existingState = existing ? store.normalizeWorkflowWorkItemState(existing.state) : null;
      const state = input.state ?? existingState ?? "runnable";
      if (existingState && store.isTerminalWorkflowWorkItemState(existingState) && existingState !== state) {
        throw new Error(
          `Workflow work item ${existing?.id ?? input.id ?? input.nodeId} is terminal (${existingState}) and cannot be requeued as ${state}`,
        );
      }

      const id = existing?.id ?? input.id ?? randomUUID();
      store.db
        .prepare(
          `INSERT INTO workflow_work_items (
             id, runId, taskId, nodeId, kind, state, attempt, retryAfter,
             leaseOwner, leaseExpiresAt, lastError, blockedReason, stableWorkflowRunId,
             continuationSequence, waitReason, sourceColumn, targetColumn, irHash, createdAt, updatedAt
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(runId, taskId, nodeId, kind) DO UPDATE SET
             state = excluded.state,
             attempt = excluded.attempt,
             retryAfter = excluded.retryAfter,
             leaseOwner = excluded.leaseOwner,
             leaseExpiresAt = excluded.leaseExpiresAt,
             lastError = excluded.lastError,
             blockedReason = excluded.blockedReason,
             stableWorkflowRunId = excluded.stableWorkflowRunId,
             continuationSequence = excluded.continuationSequence,
             waitReason = excluded.waitReason,
             sourceColumn = excluded.sourceColumn,
             targetColumn = excluded.targetColumn,
             irHash = excluded.irHash,
             updatedAt = excluded.updatedAt`,
        )
        .run(
          id,
          input.runId,
          input.taskId,
          input.nodeId,
          input.kind,
          state,
          input.attempt ?? existing?.attempt ?? 0,
          input.retryAfter === undefined ? existing?.retryAfter ?? null : input.retryAfter,
          input.leaseOwner === undefined ? existing?.leaseOwner ?? null : input.leaseOwner,
          input.leaseExpiresAt === undefined ? existing?.leaseExpiresAt ?? null : input.leaseExpiresAt,
          input.lastError === undefined ? existing?.lastError ?? null : input.lastError,
          input.blockedReason === undefined ? existing?.blockedReason ?? null : input.blockedReason,
          input.stableWorkflowRunId === undefined ? existing?.stableWorkflowRunId ?? null : input.stableWorkflowRunId,
          input.continuationSequence === undefined ? existing?.continuationSequence ?? null : input.continuationSequence,
          input.waitReason === undefined ? existing?.waitReason ?? null : input.waitReason,
          input.sourceColumn === undefined ? existing?.sourceColumn ?? null : input.sourceColumn,
          input.targetColumn === undefined ? existing?.targetColumn ?? null : input.targetColumn,
          input.irHash === undefined ? existing?.irHash ?? null : input.irHash,
          existing?.createdAt ?? now,
          now,
        );

      const row = store.db.prepare("SELECT * FROM workflow_work_items WHERE id = ?").get(id) as WorkflowWorkItemRow | undefined;
      if (!row) throw new Error(`Failed to upsert workflow work item ${id}`);
      store.insertRunAuditEventRow({
        taskId: row.taskId,
        runId: row.runId,
        domain: "database",
        mutationType: "workflowWorkItem:upsert",
        target: row.id,
        metadata: { id: row.id, nodeId: row.nodeId, kind: row.kind, state: row.state, attempt: row.attempt },
      });
      return store.rowToWorkflowWorkItem(row);
}

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
      const owner = await getWorkflowWorkItemAsync(tx, id);
      if (!owner) return null;
      return withTaskWorkflowSerialization(tx, layer.projectId, owner.taskId, async () => {
        await tx
          .update(schema.project.workflowWorkItems)
          .set({ state: "running", leaseOwner, leaseExpiresAt, updatedAt: now })
          .where(and(
            eq(schema.project.workflowWorkItems.id, id),
            inArray(schema.project.workflowWorkItems.state, ["runnable", "retrying", "running"]),
          ));
        const claimed = await getWorkflowWorkItemAsync(tx, id);
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
