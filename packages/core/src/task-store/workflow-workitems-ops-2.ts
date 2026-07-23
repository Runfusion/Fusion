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
import {replaceActiveTaskWorkflowContinuation as replaceActiveTaskWorkflowContinuationAsync, upsertWorkflowWorkItem as upsertWorkflowWorkItemAsync, transitionWorkflowWorkItem as transitionWorkflowWorkItemAsync, getWorkflowWorkItem as getWorkflowWorkItemAsync} from "../task-store/async/async-workflow-workitems.js";
import type {WorkflowWorkItemRow} from "../task-store/row-types.js";
import type {DbTransaction} from "../postgres/data-layer.js";

export async function upsertWorkflowWorkItemImpl(store: TaskStore, input: WorkflowWorkItemUpsertInput, tx?: DbTransaction): Promise<WorkflowWorkItem> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return upsertWorkflowWorkItemAsync(layer, input, tx);
    }
    return store.db.transactionImmediate(() => {
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
    });
  }

export async function replaceActiveTaskWorkflowContinuationImpl(
  store: TaskStore,
  input: WorkflowWorkItemUpsertInput & { kind: "task" },
): Promise<WorkflowWorkItem> {
  if (store.backendMode) {
    return replaceActiveTaskWorkflowContinuationAsync(store.asyncLayer!, input);
  }

  // Compatibility path for legacy embedded stores. PostgreSQL is the
  // authoritative runtime and performs this replacement atomically above.
  return store.db.transactionImmediate(() => {
    const active = store.db.prepare(
      `SELECT id, runId, nodeId, kind FROM workflow_work_items
       WHERE taskId = ? AND kind = 'task' AND state IN ('runnable', 'running', 'held', 'retrying')`,
    ).all(input.taskId) as Array<{ id: string; runId: string; nodeId: string; kind: string }>;
    for (const row of active) {
      if (row.runId === input.runId && row.nodeId === input.nodeId && row.kind === input.kind) continue;
      store.transitionWorkflowWorkItemSync(row.id, "succeeded", {
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
      });
    }
    return upsertWorkflowWorkItemImpl(store, input);
  });
}

export async function transitionWorkflowWorkItemImpl(store: TaskStore, id: string, state: WorkflowWorkItemState, patch: WorkflowWorkItemTransitionPatch = {}, tx?: DbTransaction,): Promise<WorkflowWorkItem> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return transitionWorkflowWorkItemAsync(layer, id, state, patch, tx);
    }
    return store.transitionWorkflowWorkItemSync(id, state, patch);
  }

export async function acquireWorkflowWorkItemLeaseImpl(store: TaskStore, id: string, leaseOwner: string, opts: { leaseDurationMs: number; now?: string },): Promise<WorkflowWorkItem | null> {
    if (opts.leaseDurationMs <= 0) {
      throw new Error(`workflow work item leaseDurationMs must be > 0 (received ${opts.leaseDurationMs})`);
    }

    // No dedicated async helper; use a raw Drizzle UPDATE in backend mode.
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const now = opts.now ?? new Date().toISOString();
      const leaseExpiresAt = new Date(new Date(now).getTime() + opts.leaseDurationMs).toISOString();
      // The sync path uses a guarded UPDATE (state IN runnable/retrying/running
      // + retryAfter/leaseExpiresAt passed). Use sql`` for the state-list guard.
      const result = await layer.db
        .update(schema.project.workflowWorkItems)
        .set({
          state: "running",
          leaseOwner,
          leaseExpiresAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.project.workflowWorkItems.id, id),
            inArray(schema.project.workflowWorkItems.state, ["runnable", "retrying", "running"]),
          ),
        );
      // Check if any row was updated (postgres.js returns a result with count).
      const updated = await getWorkflowWorkItemAsync(layer.db, id);
      if (!updated || updated.leaseOwner !== leaseOwner) return null;
      void result;
      // Record the audit event (fire-and-forget).
      void store.recordRunAuditEvent({
        taskId: updated.taskId,
        agentId: "system",
        runId: updated.runId,
        domain: "database",
        mutationType: "workflowWorkItem:lease-acquired",
        target: updated.id,
        metadata: { id: updated.id, leaseOwner: updated.leaseOwner, leaseExpiresAt: updated.leaseExpiresAt },
      });
      return updated;
    }

    return store.db.transactionImmediate(() => {
      const now = opts.now ?? new Date().toISOString();
      const leaseExpiresAt = new Date(new Date(now).getTime() + opts.leaseDurationMs).toISOString();
      const result = store.db
        .prepare(
          `UPDATE workflow_work_items
              SET state = 'running',
                  leaseOwner = ?,
                  leaseExpiresAt = ?,
                  updatedAt = ?
            WHERE id = ?
              AND state IN ('runnable', 'retrying', 'running')
              AND (retryAfter IS NULL OR retryAfter <= ?)
              AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)`,
        )
        .run(leaseOwner, leaseExpiresAt, now, id, now, now);
      if (result.changes === 0) return null;

      const row = store.db.prepare("SELECT * FROM workflow_work_items WHERE id = ?").get(id) as WorkflowWorkItemRow | undefined;
      if (!row) throw new Error(`Workflow work item ${id} disappeared`);
      store.insertRunAuditEventRow({
        taskId: row.taskId,
        runId: row.runId,
        domain: "database",
        mutationType: "workflowWorkItem:lease-acquired",
        target: row.id,
        metadata: { id: row.id, leaseOwner: row.leaseOwner, leaseExpiresAt: row.leaseExpiresAt },
      });
      return store.rowToWorkflowWorkItem(row);
    });
  }
