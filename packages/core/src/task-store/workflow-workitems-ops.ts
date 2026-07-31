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
import {and, eq, ne} from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";

export async function clearWorkflowRunBranchesImpl(store: TaskStore, taskId: string, keepRunId: string): Promise<void> {
    // FNXC:PostgresOnlyDataAccess 2026-07-16-12:15: backend mode previously
    // swallowed the sync throw, so stale-run branch rows were never pruned on
    // PostgreSQL.
        const table = schema.project.workflowRunBranches;
    await store.asyncLayer!.db
      .delete(table)
      .where(and(eq(table.taskId, taskId), ne(table.runId, keepRunId)));
    return;
}

export async function projectMergeRequestToWorkflowWorkItemImpl(store: TaskStore, taskId: string, opts: MergeRequestWorkflowProjectionOptions = {},): Promise<WorkflowWorkItem | null> {
    // FNXC:RuntimeWorkflowAsync 2026-06-24-17:05:
    // Converted from sync to async because upsertWorkflowWorkItem and
    // cancelActiveWorkflowWorkItemsForTask are now async. The sync
    // transactionImmediate wrapper is removed — the inner upsert/cancel already
    // run in their own transactions. The audit row is fire-and-forget.
        const layer = store.asyncLayer!;
    const record = await store.getMergeRequestRecordAsync(taskId);
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

export async function createCompletionHandoffWorkflowWorkImpl(store: TaskStore, task: Pick<Task, "id" | "autoMerge" | "priority">, opts: { runId?: string; now?: string; source?: string } = {}, tx?: import("../postgres/data-layer.js").DbTransaction): Promise<WorkflowWorkItem> {
    const autoMerge = task.autoMerge !== false;
    const runId = opts.runId ?? `completion-handoff:${task.id}:${randomUUID()}`;
    const nodeId = autoMerge ? "merge-gate" : "merge-manual-hold";
    const kind: WorkflowWorkItemKind = autoMerge ? "merge" : "manual-hold";
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-13:35:
    Completion handoff is PostgreSQL-only. The former SQLite getWorkflowWorkItemByIdentity / audit arms are deleted; cancel+upsert is the durable path.
    */
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
    return item;
}

