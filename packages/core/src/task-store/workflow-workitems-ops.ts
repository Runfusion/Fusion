/**
 * workflow-workitems-ops operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore} from "../store.js";
import {randomUUID} from "node:crypto";
import type {Task, MergeRequestWorkflowProjectionOptions, WorkflowWorkItem, WorkflowWorkItemKind} from "../types.js";
import "../builtin-traits.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {recordRunAuditEvent as recordRunAuditEventAsync} from "../postgres/data-layer.js";

export function clearWorkflowRunBranchesImpl(store: TaskStore, taskId: string, keepRunId: string): void {
    try {
      store.db
        .prepare(
          `DELETE FROM workflow_run_branches WHERE taskId = ? AND runId != ?`,
        )
        .run(taskId, keepRunId);
    } catch {
      // Legacy/missing table — pruning is additive, so degrade silently.
    }
  }

export async function projectMergeRequestToWorkflowWorkItemImpl(store: TaskStore, taskId: string, opts: MergeRequestWorkflowProjectionOptions = {},): Promise<WorkflowWorkItem | null> {
    // FNXC:RuntimeWorkflowAsync 2026-06-24-17:05:
    // Converted from sync to async because upsertWorkflowWorkItem and
    // cancelActiveWorkflowWorkItemsForTask are now async. The sync
    // transactionImmediate wrapper is removed — the inner upsert/cancel already
    // run in their own transactions. The audit row is fire-and-forget.
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const record = await store.getMergeRequestRecord(taskId);
      if (!record) return null;
      const state = store.workflowStateForMergeRequestState(record.state);
      const kind = record.state === "manual-required" ? "manual-hold" : "merge";
      const item = await store.upsertWorkflowWorkItem({
        runId: opts.runId ?? `merge-request:${taskId}`,
        taskId,
        nodeId: opts.nodeId ?? "builtin.merge.request",
        kind,
        state,
        attempt: record.attemptCount,
        lastError: record.lastError,
        blockedReason: record.state === "manual-required" ? record.lastError ?? "manual merge required" : null,
        now: opts.now ?? record.updatedAt,
      });
      await store.cancelActiveWorkflowWorkItemsForTask(taskId, {
        kinds: [kind === "manual-hold" ? "merge" : "manual-hold"],
        now: opts.now ?? record.updatedAt,
        lastError: "superseded-by-merge-request-projection",
      });
      void recordRunAuditEventAsync(layer, {
        taskId,
        agentId: "system",
        runId: item.runId,
        domain: "database",
        mutationType: "mergeRequest:workflow-projection",
        target: item.id,
        metadata: { taskId, mergeRequestState: record.state, workflowState: item.state, workItemKind: item.kind },
      });
      return item;
    }
    return store.db.transactionImmediate(() => {
      const record = store.getMergeRequestRecord(taskId);
      if (!record) return null;
      const state = store.workflowStateForMergeRequestState(record.state);
      const kind = record.state === "manual-required" ? "manual-hold" : "merge";
      // SQLite path: the async wrappers run synchronously here (no awaits in the
      // SQLite branch), so the DB writes execute inside this transaction.
      void store.upsertWorkflowWorkItem({
        runId: opts.runId ?? `merge-request:${taskId}`,
        taskId,
        nodeId: opts.nodeId ?? "builtin.merge.request",
        kind,
        state,
        attempt: record.attemptCount,
        lastError: record.lastError,
        blockedReason: record.state === "manual-required" ? record.lastError ?? "manual merge required" : null,
        now: opts.now ?? record.updatedAt,
      }).then((item) => {
        store.insertRunAuditEventRow({
          taskId,
          runId: item.runId,
          domain: "database",
          mutationType: "mergeRequest:workflow-projection",
          target: item.id,
          metadata: { taskId, mergeRequestState: record.state, workflowState: item.state, workItemKind: item.kind },
        });
      });
      void store.cancelActiveWorkflowWorkItemsForTask(taskId, {
        kinds: [kind === "manual-hold" ? "merge" : "manual-hold"],
        now: opts.now ?? record.updatedAt,
        lastError: "superseded-by-merge-request-projection",
      });
      // Re-read the projected item for the return value.
      const projected = store.getWorkflowWorkItemByIdentity(
        opts.runId ?? `merge-request:${taskId}`,
        taskId,
        opts.nodeId ?? "builtin.merge.request",
        kind,
      );
      return projected;
    });
  }

export async function createCompletionHandoffWorkflowWorkImpl(store: TaskStore, task: Pick<Task, "id" | "autoMerge" | "priority">, opts: { runId?: string; now?: string; source?: string } = {}, tx?: import("../postgres/data-layer.js").DbTransaction): Promise<WorkflowWorkItem> {
    const autoMerge = task.autoMerge !== false;
    const runId = opts.runId ?? `completion-handoff:${task.id}:${randomUUID()}`;
    const nodeId = autoMerge ? "merge-gate" : "merge-manual-hold";
    const kind: WorkflowWorkItemKind = autoMerge ? "merge" : "manual-hold";
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-15:55:
    // Backend mode: skip the sync getWorkflowWorkItemByIdentity check. The
    // async upsertWorkflowWorkItem below already handles backend mode. The
    // sync insertCompletionHandoffWorkflowWorkAudit is also skipped in backend
    // mode (the audit is handled by the surrounding transaction).
    let existing: WorkflowWorkItem | null = null;
    if (!store.backendMode) {
      existing = store.getWorkflowWorkItemByIdentity(runId, task.id, nodeId, kind);
    }
    if (existing && store.isActiveWorkflowWorkItemState(existing.state)) {
      await store.cancelActiveWorkflowWorkItemsForTask(task.id, {
        kinds: ["merge", "manual-hold"],
        excludeIds: [existing.id],
        now: opts.now,
        lastError: "superseded-by-completion-handoff",
      }, tx);
      if (!store.backendMode) {
        store.insertCompletionHandoffWorkflowWorkAudit(task, existing, autoMerge, opts.source);
      }
      return existing;
    }

    await store.cancelActiveWorkflowWorkItemsForTask(task.id, {
      kinds: ["merge", "manual-hold"],
      now: opts.now,
      lastError: "superseded-by-completion-handoff",
    }, tx);
    const item = await store.upsertWorkflowWorkItem({
      runId,
      taskId: task.id,
      nodeId,
      kind,
      state: autoMerge ? "runnable" : "manual-required",
      blockedReason: autoMerge ? null : "autoMerge:false",
      now: opts.now,
    }, tx);
    if (!store.backendMode) {
      store.insertCompletionHandoffWorkflowWorkAudit(task, item, autoMerge, opts.source);
    }
    return item;
  }

