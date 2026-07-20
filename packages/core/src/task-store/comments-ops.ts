/**
 * comments-ops operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {existsSync} from "node:fs";
import type {Task, Column, TaskDocument, TaskDocumentCreateInput, TaskLogEntry, RunMutationContext} from "../types.js";
import {validateDocumentKey} from "../types.js";
import {validateTaskDocumentPreconditions} from "../task-document-concurrency.js";
import "../builtin-traits.js";
import {toJsonNullable} from "../db.js";
import {__setTaskActivityLogLimitsForTesting, isBootstrapPromptStub} from "../task-store/comments.js";
import {getLiveTaskColumn, upsertTaskDocument as upsertTaskDocumentAsync} from "../task-store/async-comments-attachments.js";
import type {TaskDocumentRow} from "../task-store/row-types.js";

export async function addCommentImpl(store: TaskStore, id: string, text: string, author: string = "user", options?: { skipRefinement?: boolean; source?: "user" | "agent" | "github-review" | "github-review-comment"; externalId?: string; reviewState?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"; }, runContext?: RunMutationContext,): Promise<Task> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const state = await getLiveTaskColumn(layer.db, id, layer.projectId);
      if (state === "archived") throw new Error(`Task ${id} is archived — comments are read-only`);
      if (state === null) throw new Error(`Task ${id} not found`);
    }
    // Phase 1: Add comment under lock
    const task = await store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      if (!task.comments) {
        task.comments = [];
      }

      const externalSource = options?.source;
      const externalId = options?.externalId;
      if (externalSource && externalId) {
        const existing = task.comments.find((entry) => entry.source === externalSource && entry.externalId === externalId);
        if (existing) {
          return task;
        }
      }

      // Generate unique ID: timestamp + random suffix for collision resistance
      const commentId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      const comment: import("../types.js").TaskComment = {
        id: commentId,
        text,
        author,
        createdAt: now,
        updatedAt: now,
        source: options?.source,
        externalId: options?.externalId,
        reviewState: options?.reviewState,
      };

      task.comments.push(comment);
      task.updatedAt = now;
      const logEntry: TaskLogEntry = {
        timestamp: task.updatedAt,
        action: `Comment added by ${author}`,
      };
      if (runContext) {
        logEntry.runContext = runContext;
      }
      task.log.push(logEntry);

      // When runContext is provided, record audit event atomically with task mutation
      if (runContext) {
        await store.atomicWriteTaskJsonWithAudit(dir, task, {
          taskId: task.id,
          agentId: runContext.agentId,
          runId: runContext.runId,
          domain: "database",
          mutationType: "task:comment",
          target: task.id,
          metadata: { author, commentId, source: options?.source ?? null, externalId: options?.externalId ?? null },
        });
      } else {
        await store.atomicWriteTaskJson(dir, task);
      }
      if (store.isWatching) store.taskCache.set(id, { ...task });

      store.emit("task:updated", task);
      return task;
    });

    const commentContextBase: Record<string, unknown> = {
      taskId: id,
      author,
      commentLength: text.length,
      column: task.column,
      priorStatus: task.status ?? null,
    };
    if (runContext) {
      commentContextBase.runId = runContext.runId;
      commentContextBase.agentId = runContext.agentId;
      if (runContext.source) {
        commentContextBase.runSource = runContext.source;
      }
    }

    // Phase 2: Auto-refinement OUTSIDE the lock (to avoid lock contention)
    // Only create refinement for user comments on done tasks.
    // This remains best-effort: failures are logged for observability but never
    // fail the comment add operation itself.
    // Steering comments skip refinement — they are injected into the agent stream instead.
    if (task.column === "done" && author === "user" && !options?.skipRefinement) {
      try {
        await store.refineTask(id, text);
      } catch (err) {
        storeLog.warn("Best-effort post-comment auto-refinement failed", {
          ...commentContextBase,
          phase: "addComment:auto-refinement",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Phase 3: user comments on already-planned, non-executing work should
    // trigger triage re-specification. This includes awaiting-approval
    // invalidation and todo/triage tasks that have a real non-bootstrap spec.
    // This remains best-effort: failures are logged for observability but
    // never fail the comment add operation itself.
    // Note: The `task` returned above reflects the state BEFORE this
    // transition. Callers that need the post-transition status should
    // re-read the task (e.g., via getTask).
    if (author === "user" && (task.column === "todo" || task.column === "triage")) {
      let hasRealPrompt = false;
      try {
        const promptPath = join(store.taskDir(id), "PROMPT.md");
        if (existsSync(promptPath)) {
          const prompt = await readFile(promptPath, "utf-8");
          hasRealPrompt = !isBootstrapPromptStub(prompt, task.id, task.title, task.description);
        }
      } catch (err) {
        storeLog.warn("Best-effort post-comment re-triage prompt-read failed", {
          ...commentContextBase,
          phase: "addComment:retriage-prompt-read",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const shouldInvalidateAwaitingApproval =
        task.column === "triage" && task.status === "awaiting-approval";
      const shouldRetriagePlannedTask = hasRealPrompt
        && (
          task.column === "todo"
          || (task.column === "triage" && task.status !== "awaiting-approval")
        );

      if (shouldInvalidateAwaitingApproval || shouldRetriagePlannedTask) {
        const phase = shouldInvalidateAwaitingApproval
          ? "addComment:awaiting-approval-invalidation"
          : "addComment:planned-task-retriage";
        const action = shouldInvalidateAwaitingApproval
          ? "User comment invalidated spec approval — task needs re-specification"
          : "User comment requested re-specification of planned task";
        let transitioned = false;

        try {
          await store.updateTask(id, { status: "needs-replan" });
          transitioned = true;
        } catch (err) {
          storeLog.warn("Best-effort post-comment re-triage failed", {
            ...commentContextBase,
            phase,
            stage: "status-update",
            nextStatus: "needs-replan",
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (transitioned) {
          try {
            await store.logEntry(id, action, text, runContext);
          } catch (err) {
            storeLog.warn("Best-effort post-comment re-triage failed", {
              ...commentContextBase,
              phase,
              stage: "post-invalidation-log-entry",
              nextStatus: "needs-replan",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    return task;
  }

export async function upsertTaskDocumentImpl(store: TaskStore, taskId: string, input: TaskDocumentCreateInput): Promise<TaskDocument> {
    try {
      validateDocumentKey(input.key);
    } catch {
      throw new Error(
        `Invalid document key: "${input.key}". Must be 1-64 alphanumeric characters, hyphens, or underscores.`,
      );
    }

    validateTaskDocumentPreconditions(input);

    // FNXC:RuntimeWorkflowAsync 2026-06-24-17:00:
    // Backend mode: delegate the core upsert (revision archive + update) to
    // upsertTaskDocumentAsync. The citation scanning and task:updated emission
    // happen after (best-effort, same as the SQLite path).
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const document = await upsertTaskDocumentAsync(layer, taskId, input);
      const task = await store.getTask(taskId);
      store.emit("task:updated", task);
      try {
        const citationInputs = store.scanAndRecordCitations(
          input.content,
          "task_document",
          `document:${taskId}:${input.key}:rev${document.revision}`,
          input.author ?? "user",
          taskId,
          document.updatedAt,
        );
        if (citationInputs.length > 0) {
          void store.recordGoalCitations(citationInputs);
        }
      } catch (err) {
        console.warn("[fusion] Failed to scan/record goal citations from task document:", err);
      }
      return document;
    }

    const taskExists = store.db.prepare(`SELECT id, "column" FROM tasks WHERE id = ? AND ${TaskStore.ACTIVE_TASKS_WHERE}`).get(taskId) as
      | { id: string; column: Column }
      | undefined;
    if (taskExists?.column === "archived") {
      throw new Error(`Task ${taskId} is archived — documents are read-only`);
    }
    if (!taskExists) {
      if (store.isTaskArchived(taskId)) {
        throw new Error(`Task ${taskId} is archived — documents are read-only`);
      }
      throw new Error(`Task ${taskId} not found`);
    }

    const now = new Date().toISOString();
    const author = input.author ?? "user";
    const metadata = toJsonNullable(input.metadata);

    const document = store.db.transaction(() => {
      const existing = store.db
        .prepare("SELECT * FROM task_documents WHERE taskId = ? AND key = ?")
        .get(taskId, input.key) as TaskDocumentRow | undefined;

      if (existing) {
        store.db.prepare(
          `INSERT INTO task_document_revisions (taskId, key, content, revision, author, metadata, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          taskId,
          input.key,
          existing.content,
          existing.revision,
          existing.author,
          existing.metadata ?? null,
          now,
        );

        store.db.prepare(
          `UPDATE task_documents
           SET content = ?, revision = ?, author = ?, metadata = ?, updatedAt = ?
           WHERE taskId = ? AND key = ?`
        ).run(
          input.content,
          existing.revision + 1,
          author,
          metadata,
          now,
          taskId,
          input.key,
        );
      } else {
        store.db.prepare(
          `INSERT INTO task_documents (id, taskId, key, content, revision, author, metadata, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          randomUUID(),
          taskId,
          input.key,
          input.content,
          1,
          author,
          metadata,
          now,
          now,
        );
      }

      const row = store.db
        .prepare("SELECT * FROM task_documents WHERE taskId = ? AND key = ?")
        .get(taskId, input.key) as TaskDocumentRow | undefined;

      if (!row) {
        throw new Error(`Failed to upsert document ${input.key} for task ${taskId}`);
      }

      return store.rowToTaskDocument(row);
    });

    store.db.bumpLastModified();
    const task = await store.getTask(taskId);
    store.emit("task:updated", task);

    try {
      const citationInputs = store.scanAndRecordCitations(
        input.content,
        "task_document",
        `document:${taskId}:${input.key}:rev${document.revision}`,
        input.author ?? "user",
        taskId,
        document.updatedAt,
      );
      if (citationInputs.length > 0) {
        store.recordGoalCitations(citationInputs);
      }
    } catch (err) {
      console.warn("[fusion] Failed to scan/record goal citations from task document:", err);
    }

    return document;
  }
