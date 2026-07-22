/**
 * FNXC:CodeOrganization 2026-07-20-14:00:
 * Domain rename from remaining-ops-7: merge-queue peeks, archive/done transitions,
 * comments, artifacts/documents, and related task side-effect helpers.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */

import { TaskStore } from "../store.js";
import { countAgentLogEntries, readAgentLogEntries } from "../agent-log-file-store.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { toJsonNullable } from "../db.js";
import { DbTransaction, recordRunAuditEventWithinTransaction } from "../postgres/data-layer.js";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import { runCommandAsync } from "../run-command.js";
import { getStepParser } from "../step-parsers.js";
import { getTaskMergeBlocker } from "../task-merge.js";
import { deleteTaskDocument as deleteTaskDocumentAsync, getArtifact as getArtifactAsync, getArtifacts as getArtifactsAsync, getLiveTaskColumn, getTaskDocument as getTaskDocumentAsync, getTaskDocumentRevisions as getTaskDocumentRevisionsAsync, listTaskDocuments as listTaskDocumentsAsync, updateArtifactRow as updateArtifactRowAsync } from "./async/async-comments-attachments.js";
import { emitUsageEvent as emitUsageEventAsync, recordPluginActivation as recordPluginActivationAsync } from "./async/async-events.js";
import { enqueueMergeQueue as enqueueMergeQueueAsync, peekMergeQueue as peekMergeQueueAsync, peekMergeQueueHead as peekMergeQueueHeadAsync } from "./async/async-merge-coordination.js";
import { clearCompletionHandoffMarker as clearCompletionHandoffMarkerAsync, getCompletionHandoffMarker as getCompletionHandoffMarkerAsync } from "./async/async-workflow-workitems.js";
import { extractEffectiveWriteScopeFromPrompt } from "../file-scope-classification.js";
import { ArtifactRow, CompletionHandoffMarkerRow, MergeQueueRow, TaskDocumentRevisionRow, TaskDocumentRow, WorkflowWorkItemRow } from "./row-types.js";
import { AgentLogEntry, Artifact, ArtifactCreateInput, Column, CompletionHandoffMarker, MergeQueueEnqueueOptions, MergeQueueEntry, PluginActivation, PluginActivationInput, RunAuditEvent, RunMutationContext, Task, TaskDocument, TaskDocumentRevision, WorkflowWorkItem, WorkflowWorkItemKind, isColumn } from "../types.js";
import { type UsageEventInput, emitUsageEvent as emitUsageEventToDb } from "../usage-events.js";
import { DUAL_ACCEPT_PARITY_MUTATIONS, type WorkflowColumnsGraduationReport, computeWorkflowColumnsGraduationReport } from "../workflow-parity.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { storeLog } from "../store.js";

export function listWorkflowWorkItemsForTaskSyncImpl(store: TaskStore, taskId: string, opts: { kinds?: WorkflowWorkItemKind[] } = {}): WorkflowWorkItem[] {
    const conditions = ["taskId = ?"];
    const params: unknown[] = [taskId];
    if (opts.kinds?.length) {
      conditions.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
      params.push(...opts.kinds);
    }
    const rows = store.db
      .prepare(
        `SELECT *
           FROM workflow_work_items
          WHERE ${conditions.join(" AND ")}
          ORDER BY createdAt ASC, id ASC`,
      )
      .all(...params) as WorkflowWorkItemRow[];
    return rows.map((row) => store.rowToWorkflowWorkItem(row));
}

export async function clearCompletionHandoffAcceptedMarkerImpl(store: TaskStore, taskId: string): Promise<void> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const existing = await getCompletionHandoffMarkerAsync(layer.db, taskId);
      if (!existing) return;
      await clearCompletionHandoffMarkerAsync(layer.db, taskId);
      void store.recordRunAuditEvent({
        taskId,
        agentId: "system",
        runId: `completion-handoff-clear:${taskId}:${Date.now()}`,
        domain: "database",
        mutationType: "task:completion-handoff-cleared",
        target: taskId,
        metadata: { taskId, acceptedAt: existing.acceptedAt, source: existing.source },
      });
      return;
    }
    store.db.transactionImmediate(() => {
      const existing = store.db.prepare("SELECT * FROM completion_handoff_markers WHERE taskId = ?").get(taskId) as CompletionHandoffMarkerRow | undefined;
      if (!existing) return;
      store.db.prepare("DELETE FROM completion_handoff_markers WHERE taskId = ?").run(taskId);
      store.insertRunAuditEventRow({
        taskId,
        domain: "database",
        mutationType: "task:completion-handoff-cleared",
        target: taskId,
        metadata: { taskId, acceptedAt: existing.acceptedAt, source: existing.source },
      });
    });
}

export async function getCompletionHandoffAcceptedMarkerImpl(store: TaskStore, taskId: string): Promise<CompletionHandoffMarker | null> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const marker = await getCompletionHandoffMarkerAsync(layer.db, taskId);
      return marker as CompletionHandoffMarker | null;
    }
    const row = store.db.prepare("SELECT * FROM completion_handoff_markers WHERE taskId = ?").get(taskId) as CompletionHandoffMarkerRow | undefined;
    return row ? store.rowToCompletionHandoffMarker(row) : null;
}

export async function recordPluginActivationImpl(store: TaskStore, input: PluginActivationInput): Promise<PluginActivation> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return recordPluginActivationAsync(layer.db, input);
    }
    const activatedAt = input.activatedAt ?? new Date().toISOString();
    const result = store.db.prepare(`
      INSERT INTO plugin_activations (pluginId, source, pluginVersion, activatedAt)
      VALUES (?, ?, ?, ?)
    `).run(input.pluginId, input.source, input.pluginVersion ?? null, activatedAt);

    return {
      id: Number(result.lastInsertRowid),
      pluginId: input.pluginId,
      source: input.source,
      pluginVersion: input.pluginVersion ?? null,
      activatedAt,
    };
}

export async function computeWorkflowColumnsGraduationReportImpl(store: TaskStore,
    options: { since?: string; limit?: number } = {},
  ): Promise<WorkflowColumnsGraduationReport> {
    const limit = options.limit ?? 1000;
    const parity = await store.getWorkflowParitySummary(options);
    const dualAcceptEvents: RunAuditEvent[] = [];
    for (const mutationType of DUAL_ACCEPT_PARITY_MUTATIONS) {
      dualAcceptEvents.push(
        ...await store.getRunAuditEventsAsync({
          domain: "database",
          mutationType: mutationType as unknown as RunAuditEvent["mutationType"],
          startTime: options.since,
          limit,
        }),
      );
    }
    return computeWorkflowColumnsGraduationReport({
      parity,
      defaultWorkflowIr: BUILTIN_CODING_WORKFLOW_IR,
      dualAcceptEvents,
    });
}

export async function enqueueMergeQueueImpl(store: TaskStore, taskId: string, opts: MergeQueueEnqueueOptions = {}): Promise<MergeQueueEntry> {
    // FNXC:RuntimeLifecycleAsync 2026-06-24-11:12:
    // Backend-mode: delegate to the async merge-coordination helper (async-merge-coordination.ts).
    // This preserves enqueue semantics (column check, idempotent ON CONFLICT DO NOTHING insert,
    // mergeQueue:enqueue audit event) against PostgreSQL via Drizzle.
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return enqueueMergeQueueAsync(layer, taskId, opts);
    }
    // SQLite path: delegate to the sync internal (also used by moveTaskInternal).
    return store.enqueueMergeQueueSyncInternal(taskId, opts);
}

export function cleanupStaleMergeQueueRowsImpl(store: TaskStore, now: string): void {
    const staleRows = store.db.prepare(`
      SELECT mq.taskId, mq.leasedBy, mq.leaseExpiresAt, t.column
        FROM mergeQueue mq
        LEFT JOIN tasks t ON t.id = mq.taskId
       WHERE t.id IS NULL OR t.column != 'in-review'
    `).all() as Array<{ taskId: string; leasedBy: string | null; leaseExpiresAt: string | null; column: Column | null }>;

    for (const staleRow of staleRows) {
      store.db.prepare("DELETE FROM mergeQueue WHERE taskId = ?").run(staleRow.taskId);
      store.insertRunAuditEventRow({
        taskId: staleRow.taskId,
        domain: "database",
        mutationType: "mergeQueue:auto-cleanup-stale-row",
        target: staleRow.taskId,
        metadata: {
          taskId: staleRow.taskId,
          column: staleRow.column,
          leasedBy: staleRow.leasedBy,
          leaseExpiresAt: staleRow.leaseExpiresAt,
          cleanedAt: now,
          reason: "not-in-review",
        },
      });
    }
}

export async function peekMergeQueueImpl(store: TaskStore): Promise<MergeQueueEntry[]> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return peekMergeQueueAsync(layer);
    }
    const rows = store.db.prepare(`
      SELECT * FROM mergeQueue
      ORDER BY CASE priority
                 WHEN 'urgent' THEN 0
                 WHEN 'high'   THEN 1
                 WHEN 'normal' THEN 2
                 WHEN 'low'    THEN 3
                 ELSE 4
               END ASC,
               enqueuedAt ASC
    `).all() as MergeQueueRow[];
    return rows.map((row) => store.rowToMergeQueueEntry(row));
}

export async function peekMergeQueueHeadImpl(store: TaskStore): Promise<{ taskId: string; leasedBy: string | null; column: Column | null } | null> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const head = await peekMergeQueueHeadAsync(layer);
      // The async helper returns column as string | null (Drizzle text column);
      // cast to the Column union for the public API contract.
      return head ? { ...head, column: head.column as Column | null } : null;
    }
    const row = store.db.prepare(`
      SELECT mq.taskId, mq.leasedBy, t.column
        FROM mergeQueue mq
        LEFT JOIN tasks t ON t.id = mq.taskId
       ORDER BY CASE mq.priority
                  WHEN 'urgent' THEN 0
                  WHEN 'high'   THEN 1
                  WHEN 'normal' THEN 2
                  WHEN 'low'    THEN 3
                  ELSE 4
                END ASC,
                mq.enqueuedAt ASC
       LIMIT 1
    `).get() as { taskId: string; leasedBy: string | null; column: Column | null } | undefined;
    return row ?? null;
}

export async function parseStepsFromPromptImpl(store: TaskStore, id: string): Promise<import("../types.js").TaskStep[]> {
    const dir = store.taskDir(id);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) return [];

    const content = await readFile(promptPath, "utf-8");
    // Step-inversion U12 (KTD-12): delegate to the registry's `step-headings`
    // parser (resolved by id, not a direct import) so the registry path is
    // proven and stays byte-identical to the extracted function. The parser
    // yields `{ name, dependsOn? }`; re-apply the `pending` status here.
    const parser = getStepParser("step-headings");
    if (!parser) {
      throw new Error("Step parser 'step-headings' is not registered");
    }
    return parser.parse(content).steps.map((s) =>
      s.dependsOn
        ? { name: s.name, status: "pending" as const, dependsOn: s.dependsOn }
        : { name: s.name, status: "pending" as const },
    );
}

export async function parseDependenciesFromPromptImpl(store: TaskStore, id: string): Promise<string[]> {
    const dir = store.taskDir(id);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) return [];

    const content = await readFile(promptPath, "utf-8");

    // Find the ## Dependencies section.
    // We locate the heading then slice to the next heading (or end of file)
    // to avoid multiline `$` anchor issues with lazy quantifiers.
    const headingMatch = content.match(/^##\s+Dependencies\s*$/m);
    if (!headingMatch) return [];

    const startIdx = headingMatch.index! + headingMatch[0].length;
    const rest = content.slice(startIdx);
    const nextHeading = rest.search(/\n##?\s/);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

    const ids: string[] = [];
    const taskIdRegex = /^-\s+\*\*Task:\*\*\s+([A-Z]+-\d+)/gm;
    let match;
    while ((match = taskIdRegex.exec(section)) !== null) {
      ids.push(match[1]);
    }

    return ids;
}

export async function parseFileScopeFromPromptImpl(store: TaskStore, id: string): Promise<string[]> {
    const dir = store.taskDir(id);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) return [];

    const content = await readFile(promptPath, "utf-8");

    return extractEffectiveWriteScopeFromPrompt(content);
}

export async function recordRunAuditEventBackendImpl(store: TaskStore,
    tx: DbTransaction,
    event: {
      domain: string;
      mutationType: string;
      target: string;
      taskId: string;
      agentId: string;
      runId: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await recordRunAuditEventWithinTransaction(tx, {
      taskId: event.taskId,
      agentId: event.agentId,
      runId: event.runId,
      domain: event.domain as "database",
      mutationType: event.mutationType,
      target: event.target,
      metadata: event.metadata,
    });
}

export function rewriteLineageChildrenForRemovalImpl(store: TaskStore, parentId: string, childIds: string[]): Task[] {
    const rewrittenChildren: Task[] = [];

    for (const childId of childIds) {
      const childTask = store.readTaskFromDb(childId);
      if (!childTask || childTask.sourceParentTaskId !== parentId) continue;

      const updatedChild: Task = {
        ...childTask,
        sourceParentTaskId: undefined,
        updatedAt: new Date().toISOString(),
      };

      store.db.prepare("UPDATE tasks SET sourceParentTaskId = NULL, updatedAt = ? WHERE id = ?").run(updatedChild.updatedAt, updatedChild.id);
      if (store.isWatching) {
        store.taskCache.set(updatedChild.id, updatedChild);
      }
      rewrittenChildren.push(updatedChild);
    }

    return rewrittenChildren;
}

export async function syncAgentTaskLinkOnReassignmentImpl(store: TaskStore,
    taskId: string,
    previousAgentId: string | undefined,
    newAgentId: string | undefined,
  ): Promise<void> {
    const updatedAt = new Date().toISOString();

    /*
    FNXC:PostgresCutover 2026-07-04-00:00:
    Backend-mode agent-task-link sync: update the agents.taskId column via async Drizzle. Only the dedicated taskId column is authoritative in PG (agent.data jsonb is not read for the link), so the SQLite json_set/json_remove on data is not mirrored.
    */
    if (store.backendMode) {
      const db = store.asyncLayer!.db;
      if (previousAgentId) {
        await db
          .update(schema.project.agents)
          .set({ taskId: null, updatedAt })
          .where(and(eq(schema.project.agents.id, previousAgentId), eq(schema.project.agents.taskId, taskId)));
      }
      if (newAgentId) {
        await db
          .update(schema.project.agents)
          .set({ taskId, updatedAt })
          .where(eq(schema.project.agents.id, newAgentId));
      }
      return;
    }

    if (previousAgentId) {
      store.db.prepare(`
        UPDATE agents
        SET
          taskId = NULL,
          updatedAt = ?,
          data = CASE
            WHEN json_valid(data) THEN json_set(json_remove(data, '$.taskId'), '$.updatedAt', ?)
            ELSE data
          END
        WHERE id = ? AND taskId = ?
      `).run(updatedAt, updatedAt, previousAgentId, taskId);
    }

    if (newAgentId) {
      store.db.prepare(`
        UPDATE agents
        SET
          taskId = ?,
          updatedAt = ?,
          data = CASE
            WHEN json_valid(data) THEN json_set(data, '$.taskId', ?, '$.updatedAt', ?)
            ELSE data
          END
        WHERE id = ?
      `).run(taskId, updatedAt, taskId, updatedAt, newAgentId);
    }
}

export async function runGitCommandImpl(store: TaskStore, command: string, timeoutMs = 10_000) {
    return runCommandAsync(command, {
      cwd: store.rootDir,
      timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
}

export async function clearStaleExecutionStartBranchReferencesImpl(store: TaskStore, deletedBranches: string[], ownerTaskId?: string): Promise<string[]> {
    if (deletedBranches.length === 0) return [];
    if (store.backendMode) {
      /*
      FNXC:PostgresBranchCleanup 2026-07-14-17:30:
      Deleted execution-start branches must be cleared from every other live task in PostgreSQL. Returning an empty safe default leaves durable references to branches that no longer exist and turns later worktree creation into a false hard failure.
      */
      const now = new Date().toISOString();
      const conditions = [
        isNull(schema.project.tasks.deletedAt),
        inArray(schema.project.tasks.executionStartBranch, deletedBranches),
      ];
      if (ownerTaskId) conditions.push(ne(schema.project.tasks.id, ownerTaskId));
      const rows = await store.asyncLayer!.db
        .update(schema.project.tasks)
        .set({ executionStartBranch: null, updatedAt: now })
        .where(and(...conditions))
        .returning({ id: schema.project.tasks.id });
      const clearedIds = rows.map((row) => row.id);
      if (store.isWatching) {
        for (const id of clearedIds) {
          const cached = store.taskCache.get(id);
          if (cached) {
            cached.executionStartBranch = undefined;
            cached.updatedAt = now;
          }
        }
      }
      return clearedIds;
    }
    const placeholders = deletedBranches.map(() => "?").join(",");
    const params: string[] = [...deletedBranches];
    let whereClause = `executionStartBranch IN (${placeholders})`;
    if (ownerTaskId) {
      whereClause += ` AND id != ?`;
      params.push(ownerTaskId);
    }
    const rows = store.db
      .prepare(`SELECT id FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE} AND ${whereClause}`)
      .all(...params) as Array<{ id: string }>;

    if (rows.length === 0) return [];
    const update = store.db.prepare(
      `UPDATE tasks SET executionStartBranch = NULL, updatedAt = ? WHERE id = ?`,
    );
    const now = new Date().toISOString();
    const clearedIds: string[] = [];
    for (const row of rows) {
      update.run(now, row.id);
      clearedIds.push(row.id);
      if (store.isWatching) {
        const cached = store.taskCache.get(row.id);
        if (cached) {
          cached.executionStartBranch = undefined;
          cached.updatedAt = now;
        }
      }
    }
    store.db.bumpLastModified();
    return clearedIds;
}

export async function archiveAllDoneImpl(store: TaskStore, options?: { removeLineageReferences?: boolean }): Promise<Task[]> {
    const doneTasks = await store.listTasks({ slim: true, column: "done" });

    if (doneTasks.length === 0) {
      return [];
    }

    // Archive all done tasks concurrently
    const archivedTasks = await Promise.all(
      doneTasks.map((task) =>
        store.archiveTask(task.id, {
          cleanup: true,
          removeLineageReferences: options?.removeLineageReferences,
        })
      )
    );

    return archivedTasks;
}

export function resolveUnarchiveTargetColumnImpl(store: TaskStore, preArchiveColumn: unknown): Column {
    if (!isColumn(preArchiveColumn) || preArchiveColumn === "archived") {
      return "done";
    }
    if (preArchiveColumn === "in-progress" || preArchiveColumn === "in-review") {
      return "todo";
    }
    return preArchiveColumn;
}

export async function readPreArchiveColumnFromTaskFileImpl(store: TaskStore, dir: string): Promise<Column | undefined> {
    try {
      const raw = await readFile(join(dir, "task.json"), "utf-8");
      const parsed = JSON.parse(raw) as { preArchiveColumn?: unknown };
      return isColumn(parsed.preArchiveColumn) ? parsed.preArchiveColumn : undefined;
    } catch {
      return undefined;
    }
}

export async function moveToDoneImpl(store: TaskStore, task: Task, dir: string): Promise<void> {
    if (task.column === "done") {
      return;
    }

    const fromColumn = task.column;
    const mergeBlocker = getTaskMergeBlocker(task);
    if (mergeBlocker) {
      throw new Error(`Cannot move ${task.id} to done: ${mergeBlocker}`);
    }

    task.column = "done";
    store.clearDoneTransientFields(task);
    task.columnMovedAt = new Date().toISOString();
    task.updatedAt = task.columnMovedAt;
    if (!task.executionCompletedAt) {
      task.executionCompletedAt = task.columnMovedAt;
    }

    await store.atomicWriteTaskJson(dir, task);

    // Update cache if watcher is active
    if (store.isWatching) store.taskCache.set(task.id, { ...task });

    store.emit("task:moved", { task, from: fromColumn, to: "done" as Column, source: "engine" });
}

export function clearDoneTransientFieldsImpl(store: TaskStore, task: Task): boolean {
    const changed = task.status !== undefined
      || task.error !== undefined
      || task.worktree !== undefined
      || task.blockedBy !== undefined
      || task.overlapBlockedBy !== undefined
      || task.recoveryRetryCount !== undefined
      || task.nextRecoveryAt !== undefined
      || task.paused !== undefined
      || task.userPaused !== undefined
      || task.pausedByAgentId !== undefined
      || task.pausedReason !== undefined;

    task.status = undefined;
    task.error = undefined;
    task.worktree = undefined;
    task.blockedBy = undefined;
    task.overlapBlockedBy = undefined;
    task.recoveryRetryCount = undefined;
    task.nextRecoveryAt = undefined;
    task.paused = undefined;
    task.userPaused = undefined;
    task.pausedByAgentId = undefined;
    task.pausedReason = undefined;

    return changed;
}

export function stopWatchingImpl(store: TaskStore): void {
    if (store.watcher) {
      store.watcher.close();
      store.watcher = null;
    }
    if (store.pollInterval) {
      clearInterval(store.pollInterval);
      store.pollInterval = null;
    }
    for (const timer of store.debounceTimers.values()) {
      clearTimeout(timer);
    }
    store.debounceTimers.clear();
    store.taskCache.clear();
    store.recentlyWritten.clear();
    store.clearStartupSlimListMemo();
}

export async function getAttachmentImpl(store: TaskStore,
    id: string,
    filename: string,
  ): Promise<{ path: string; mimeType: string }> {
    const dir = store.taskDir(id);
    const task = await store.readTaskJson(dir);
    const attachment = task.attachments?.find((a) => a.filename === filename);
    if (!attachment) {
      const err: NodeJS.ErrnoException = new Error(
        `Attachment '${filename}' not found on task ${id}`,
      );
      err.code = "ENOENT";
      throw err;
    }
    return {
      path: join(dir, "attachments", filename),
      mimeType: attachment.mimeType,
    };
}

export async function emitUsageEventImpl(store: TaskStore, event: UsageEventInput): Promise<boolean> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return emitUsageEventAsync(layer.db, layer.projectId ?? "", event);
    }
    return emitUsageEventToDb(store.db, event);
}

export async function addSteeringCommentImpl(store: TaskStore, id: string, text: string, author: "user" | "agent" = "user", runContext?: RunMutationContext): Promise<Task> {
    // Write to unified comments (skip refinement — steering is for agent injection, not follow-up tasks)
    const task = await store.addComment(id, text, author, { skipRefinement: true }, runContext);

    // Also write to steeringComments so the executor's real-time injection listener can detect new entries
    const updated = await store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const currentTask = await store.readTaskJson(dir);

      const steeringComment: import("../types.js").SteeringComment = {
        id: task.comments![task.comments!.length - 1].id,
        text,
        createdAt: new Date().toISOString(),
        author,
      };

      if (!currentTask.steeringComments) {
        currentTask.steeringComments = [];
      }
      currentTask.steeringComments.push(steeringComment);
      currentTask.updatedAt = new Date().toISOString();

      await store.atomicWriteTaskJson(dir, currentTask);
      if (store.isWatching) store.taskCache.set(id, { ...currentTask });

      store.emit("task:updated", currentTask);
      return currentTask;
    });

    return updated;
}

export async function updateTaskCommentImpl(store: TaskStore, id: string, commentId: string, text: string): Promise<Task> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const state = await getLiveTaskColumn(layer.db, id, layer.projectId);
      if (state === "archived") throw new Error(`Task ${id} is archived — comments are read-only`);
      if (state === null) throw new Error(`Task ${id} not found`);
    }
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const comments = task.comments || [];
      const comment = comments.find((entry) => entry.id === commentId);

      if (!comment) {
        throw new Error(`Comment ${commentId} not found on task ${id}`);
      }

      comment.text = text;
      comment.updatedAt = new Date().toISOString();
      task.comments = comments;
      task.updatedAt = comment.updatedAt;
      task.log.push({
        timestamp: task.updatedAt,
        action: "Comment updated",
      });

      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });

      store.emit("task:updated", task);
      return task;
    });
}

export async function deleteTaskCommentImpl(store: TaskStore, id: string, commentId: string): Promise<Task> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const state = await getLiveTaskColumn(layer.db, id, layer.projectId);
      if (state === "archived") throw new Error(`Task ${id} is archived — comments are read-only`);
      if (state === null) throw new Error(`Task ${id} not found`);
    }
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const currentComments = task.comments || [];
      const nextComments = currentComments.filter((entry) => entry.id !== commentId);

      if (nextComments.length === currentComments.length) {
        throw new Error(`Comment ${commentId} not found on task ${id}`);
      }

      task.comments = nextComments.length > 0 ? nextComments : undefined;
      task.updatedAt = new Date().toISOString();
      task.log.push({
        timestamp: task.updatedAt,
        action: "Comment deleted",
      });

      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });

      store.emit("task:updated", task);
      return task;
    });
}

export async function writeArtifactDataImpl(store: TaskStore, input: ArtifactCreateInput, id: string): Promise<{ uri?: string; sizeBytes?: number; absolutePath?: string }> {
    if (!input.data) {
      return {};
    }

    const storedName = TaskStore.artifactStoredName(id, input.title);
    if (input.taskId) {
      const artifactDir = join(store.taskDir(input.taskId), "artifacts");
      await mkdir(artifactDir, { recursive: true });
      const absolutePath = join(artifactDir, storedName);
      await writeFile(absolutePath, input.data);
      return { uri: `artifacts/${storedName}`, sizeBytes: input.data.length, absolutePath };
    }

    const artifactDir = store.artifactRegistryDir();
    await mkdir(artifactDir, { recursive: true });
    const absolutePath = join(artifactDir, storedName);
    await writeFile(absolutePath, input.data);
    return { uri: `artifacts/${storedName}`, sizeBytes: input.data.length, absolutePath };
}

export function insertArtifactRowImpl(store: TaskStore, input: ArtifactCreateInput, id: string, now: string, stored: { uri?: string; sizeBytes?: number }): Artifact {
    store.db.prepare(
      `INSERT INTO artifacts (
        id, type, title, description, mimeType, sizeBytes, uri, content, authorId, authorType, taskId, metadata, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.type,
      input.title,
      input.description ?? null,
      input.mimeType ?? null,
      stored.sizeBytes ?? input.sizeBytes ?? null,
      stored.uri ?? input.uri ?? null,
      input.data ? null : input.content ?? null,
      input.authorId,
      input.authorType,
      input.taskId ?? null,
      toJsonNullable(input.metadata),
      now,
      now,
    );

    const row = store.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    if (!row) {
      throw new Error(`Failed to register artifact ${id}`);
    }
    return store.rowToArtifact(row);
}

export async function getArtifactImpl(store: TaskStore, id: string): Promise<Artifact | null> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return getArtifactAsync(layer.db, id);
    }
    const row = store.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    return row ? store.rowToArtifact(row) : null;
}

/**
 * FNXC:ArtifactRegistry 2026-07-10-15:20 (merge port from main):
 * The dashboard Artifacts view lets operators edit any inline-content document artifact in place
 * (title/description/content). Binary artifacts (rows with a uri) keep content non-editable because
 * their payload lives on disk; only metadata edits are allowed there. Archived-task artifacts stay
 * read-only, mirroring registerArtifact. Emits `artifact:updated` and bumps lastModified so open
 * artifact lists live-refresh.
 */
export async function updateArtifactImpl(store: TaskStore, id: string, updates: { title?: string; description?: string; content?: string }): Promise<Artifact> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const updated = await updateArtifactRowAsync(layer, id, updates);
      store.emit("artifact:updated", updated);
      return updated;
    }

    const existing = await store.getArtifact(id);
    if (!existing) {
      throw new Error(`Artifact ${id} not found`);
    }

    if (existing.taskId && store.isTaskArchived(existing.taskId)) {
      throw new Error(`Task ${existing.taskId} is archived — artifacts are read-only`);
    }

    if (updates.content !== undefined && existing.uri) {
      throw new Error(`Artifact ${id} stores a binary payload; its content is not editable`);
    }

    const now = new Date().toISOString();
    store.db.prepare(
      "UPDATE artifacts SET title = ?, description = ?, content = ?, updatedAt = ? WHERE id = ?",
    ).run(
      updates.title !== undefined ? updates.title : existing.title,
      updates.description !== undefined ? updates.description : existing.description ?? null,
      updates.content !== undefined ? updates.content : existing.content ?? null,
      now,
      id,
    );

    const updated = await store.getArtifact(id);
    if (!updated) {
      throw new Error(`Failed to update artifact ${id}`);
    }

    store.db.bumpLastModified();
    store.emit("artifact:updated", updated);
    return updated;
}

export async function getArtifactsImpl(store: TaskStore, taskId: string): Promise<Artifact[]> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return getArtifactsAsync(layer.db, taskId, layer.projectId);
    }
    if (!store.hasActiveTask(taskId)) {
      return [];
    }

    const rows = store.db
      .prepare("SELECT * FROM artifacts WHERE taskId = ? ORDER BY createdAt DESC")
      .all(taskId) as unknown as ArtifactRow[];
    return rows.map((row) => store.rowToArtifact(row));
}

export async function getTaskDocumentsImpl(store: TaskStore, taskId: string): Promise<TaskDocument[]> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return listTaskDocumentsAsync(layer.db, taskId, layer.projectId);
    }
    if (!store.hasActiveTask(taskId)) {
      return [];
    }

    const rows = store.db
      .prepare("SELECT * FROM task_documents WHERE taskId = ? ORDER BY key")
      .all(taskId) as unknown as TaskDocumentRow[];
    return rows.map((row) => store.rowToTaskDocument(row));
}

export async function getTaskDocumentImpl(store: TaskStore, taskId: string, key: string): Promise<TaskDocument | null> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return getTaskDocumentAsync(layer.db, taskId, key, layer.projectId);
    }
    if (!store.hasActiveTask(taskId)) {
      return null;
    }

    const row = store.db
      .prepare("SELECT * FROM task_documents WHERE taskId = ? AND key = ?")
      .get(taskId, key) as unknown as TaskDocumentRow | undefined;
    if (!row) return null;
    return store.rowToTaskDocument(row);
}

export async function getTaskDocumentRevisionsImpl(store: TaskStore,
    taskId: string,
    key: string,
    options?: { limit?: number },
  ): Promise<TaskDocumentRevision[]> {
    /*
    FNXC:PostgresCutover 2026-07-04:
    Backend-mode read of task_document_revisions via the async Drizzle helper.
    The helper returns revisions newest-first by createdAt; the sync SQLite
    path orders by revision DESC, so we re-sort by revision descending in JS
    to preserve that ordering exactly, then apply the optional LIMIT.
    */
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const rows = await getTaskDocumentRevisionsAsync(layer.db, taskId, key, layer.projectId);
      const sorted = [...rows].sort((a, b) => b.revision - a.revision);
      const mapped = sorted.map((row) => store.rowToTaskDocumentRevision(row));
      return options?.limit !== undefined ? mapped.slice(0, Math.max(0, options.limit)) : mapped;
    }
    if (!store.hasActiveTask(taskId)) {
      return [];
    }

    const hasLimit = options?.limit !== undefined;
    const rows = hasLimit
      ? (store.db
          .prepare(
            "SELECT * FROM task_document_revisions WHERE taskId = ? AND key = ? ORDER BY revision DESC LIMIT ?",
          )
          .all(taskId, key, Math.max(0, options.limit ?? 0)) as unknown as TaskDocumentRevisionRow[])
      : (store.db
          .prepare(
            "SELECT * FROM task_document_revisions WHERE taskId = ? AND key = ? ORDER BY revision DESC",
          )
          .all(taskId, key) as unknown as TaskDocumentRevisionRow[]);

    return rows.map((row) => store.rowToTaskDocumentRevision(row));
}

export async function deleteTaskDocumentImpl(store: TaskStore, taskId: string, key: string): Promise<void> {
    /*
    FNXC:PostgresCutover 2026-07-04:
    Backend-mode delete via the async Drizzle helper (deleteTaskDocument in
    async-comments-attachments.ts). The helper verifies existence (throwing the
    same "not found" error) and removes revisions + document in one transaction.
    The post-delete task:updated emit mirrors the SQLite path; getTask returns
    only live tasks so a present task implies deletedAt == null.
    */
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      await deleteTaskDocumentAsync(layer, taskId, key);
      const task = await store.getTask(taskId);
      if (task) {
        store.emit("task:updated", task);
      }
      return;
    }
    const existing = store.db
      .prepare("SELECT id FROM task_documents WHERE taskId = ? AND key = ?")
      .get(taskId, key) as { id: string } | undefined;

    if (!existing) {
      throw new Error(`Document ${key} not found for task ${taskId}`);
    }

    store.db.transaction(() => {
      store.db
        .prepare("DELETE FROM task_document_revisions WHERE taskId = ? AND key = ?")
        .run(taskId, key);

      const result = store.db
        .prepare("DELETE FROM task_documents WHERE taskId = ? AND key = ?")
        .run(taskId, key) as { changes?: number };

      if ((result.changes ?? 0) === 0) {
        throw new Error(`Document ${key} not found for task ${taskId}`);
      }
    });

    store.db.bumpLastModified();
    const task = store.readTaskFromDb(taskId, { includeDeleted: true });
    if (task && task.deletedAt == null) {
      store.emit("task:updated", task);
    }
}

export function resolvePrimaryPrInfoImpl(store: TaskStore, prInfos: import("../types.js").PrInfo[]): import("../types.js").PrInfo | undefined {
    // Primary selection rule: prefer the most-recently-updated open PR; if none are open,
    // fall back to the first linked PR for stable back-compat rendering.
    const openPrs = prInfos.filter((entry) => entry.status === "open");
    if (openPrs.length === 0) return prInfos[0];
    const sorted = [...openPrs].sort((a, b) => {
      const aTs = Date.parse(a.lastCheckedAt ?? a.lastCommentAt ?? "");
      const bTs = Date.parse(b.lastCheckedAt ?? b.lastCommentAt ?? "");
      if (Number.isFinite(aTs) && Number.isFinite(bTs)) return bTs - aTs;
      if (Number.isFinite(aTs)) return -1;
      if (Number.isFinite(bTs)) return 1;
      return 0;
    });
    return sorted[0] ?? prInfos[0];
}

export function upsertPrInfoByNumberImpl(store: TaskStore, prInfos: import("../types.js").PrInfo[], prInfo: import("../types.js").PrInfo): import("../types.js").PrInfo[] {
    const idx = prInfos.findIndex((entry) => entry.number === prInfo.number);
    if (idx >= 0) {
      const next = [...prInfos];
      next[idx] = { ...next[idx], ...prInfo };
      return next;
    }
    return [prInfo, ...prInfos];
}

export async function addPrInfoImpl(store: TaskStore, id: string, prInfo: import("../types.js").PrInfo): Promise<Task | undefined> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      let prInfos = store.getTaskPrInfos(task);
      const existingIndex = prInfos.findIndex((entry) => entry.number === prInfo.number);
      if (existingIndex >= 0) {
        prInfos[existingIndex] = { ...prInfos[existingIndex], ...prInfo };
      } else {
        prInfos = [prInfo, ...prInfos];
      }
      task.prInfos = prInfos;
      task.prInfo = store.resolvePrimaryPrInfo(prInfos);
      task.updatedAt = new Date().toISOString();
      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });
      store.emit("task:updated", task);
      return task;
    });
}

export async function updatePrInfoByNumberImpl(store: TaskStore, id: string, number: number, patch: Partial<import("../types.js").PrInfo>): Promise<Task | undefined> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const prInfos = store.getTaskPrInfos(task);
      const index = prInfos.findIndex((entry) => entry.number === number);
      if (index < 0) {
        storeLog.warn(`[store] updatePrInfoByNumber: PR #${number} not found for ${id}`);
        return task;
      }
      prInfos[index] = { ...prInfos[index], ...patch };
      task.prInfos = prInfos;
      task.prInfo = store.resolvePrimaryPrInfo(prInfos);
      task.updatedAt = new Date().toISOString();
      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });
      store.emit("task:updated", task);
      return task;
    });
}

export async function removePrInfoByNumberImpl(store: TaskStore, id: string, number: number): Promise<Task | undefined> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const prInfos = store.getTaskPrInfos(task).filter((entry) => entry.number !== number);
      if ((task.prInfos ?? []).length === prInfos.length && task.prInfo?.number !== number) {
        storeLog.warn(`[store] removePrInfoByNumber: PR #${number} not found for ${id}`);
        return task;
      }
      task.prInfos = prInfos.length > 0 ? prInfos : undefined;
      task.prInfo = store.resolvePrimaryPrInfo(prInfos);
      task.updatedAt = new Date().toISOString();
      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });
      store.emit("task:updated", task);
      return task;
    });
}

export async function updateGithubTrackingImpl(store: TaskStore,
    id: string,
    tracking: import("../types.js").TaskGithubTracking | null,
  ): Promise<Task> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const nextTracking = tracking ?? undefined;
      const previousTracking = task.githubTracking;

      if (JSON.stringify(previousTracking ?? null) === JSON.stringify(nextTracking ?? null)) {
        return task;
      }

      task.githubTracking = nextTracking;
      task.log.push({
        timestamp: new Date().toISOString(),
        action: tracking?.enabled === false ? "GitHub tracking disabled" : "GitHub tracking enabled",
      });
      task.updatedAt = new Date().toISOString();

      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });
      store.emit("task:updated", task);
      return task;
    });
}

export async function linkGithubIssueImpl(store: TaskStore,
    id: string,
    issue: import("../types.js").TaskGithubTrackedIssue,
  ): Promise<Task> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const previous = task.githubTracking ?? {};

      const nextTracking: import("../types.js").TaskGithubTracking = {
        ...previous,
        issue,
        enabled: previous.enabled ?? true,
      };

      if (JSON.stringify(previous) === JSON.stringify(nextTracking)) {
        return task;
      }

      task.githubTracking = nextTracking;
      task.log.push({
        timestamp: new Date().toISOString(),
        action: "GitHub issue linked",
        outcome: `${issue.owner}/${issue.repo}#${issue.number}`,
      });
      task.updatedAt = new Date().toISOString();

      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });
      store.emit("task:updated", task);
      return task;
    });
}

/*
FNXC:AgentLogRead 2026-07-16-00:00:
Issue #2149 requires read-only type filtering to reach the file store before pagination so task-chat log pages and their totals are coherent.
*/
export async function getAgentLogsImpl(store: TaskStore,
    taskId: string,
    options?: { limit?: number; offset?: number; type?: AgentLogEntry["type"] },
  ): Promise<AgentLogEntry[]> {
    // Ensure buffered entries are visible before reading.
    store.flushAgentLogBuffer();
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-15:45:
    // Backend mode: skip the sync readTaskFromDb deleted-check.
    if (!store.backendMode) {
      if (store.readTaskFromDb(taskId, { includeDeleted: true })?.deletedAt) {
        return [];
      }
    }
    const limit = options?.limit !== undefined
      ? (Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 0)
      : undefined;
    const offset = options?.offset !== undefined
      ? (Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset)) : 0)
      : 0;

    if (limit === 0) return [];

    return readAgentLogEntries(store.taskDir(taskId), { limit, offset, type: options?.type }).map(
      ({ lineNo: _lineNo, sourceRef: _sourceRef, ...entry }) => entry,
    );
}

export async function getAgentLogCountImpl(
  store: TaskStore,
  taskId: string,
  options?: { type?: AgentLogEntry["type"] },
): Promise<number> {
    store.flushAgentLogBuffer();
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-15:45:
    // Backend mode: skip the sync readTaskFromDb check. The agent log file
    // is read from the file system regardless; the deleted-task check is a
    // best-effort optimization that is not critical for the archive path.
    if (!store.backendMode) {
      if (store.readTaskFromDb(taskId, { includeDeleted: true })?.deletedAt) {
        return 0;
      }
    }
    return countAgentLogEntries(store.taskDir(taskId), { type: options?.type });
}
