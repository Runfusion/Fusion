/**
 * merge-queue-ops-2 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import {MergeQueueTaskNotFoundError, MergeQueueInvalidColumnError, MergeQueueLeaseOwnershipError} from "./errors.js";
import type {Task, Column, MergeResult, MergeQueueEntry, MergeQueueEnqueueOptions, MergeQueueReleaseOutcome, MergeRequestState} from "../types.js";
import "../builtin-traits.js";
import {normalizeTaskPriority} from "../task-priority.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {releaseMergeQueueLease as releaseMergeQueueLeaseAsync} from "../task-store/async-merge-coordination.js";
import type {MergeQueueRow} from "../task-store/row-types.js";

export function isValidMergeRequestTransitionImpl(store: TaskStore, from: MergeRequestState, to: MergeRequestState): boolean {
    if (from === to) return true;
    const allowed: Record<MergeRequestState, ReadonlySet<MergeRequestState>> = {
      queued: new Set(["running", "cancelled"]),
      running: new Set(["retrying", "succeeded", "exhausted", "cancelled"]),
      retrying: new Set(["queued", "cancelled", "exhausted"]),
      succeeded: new Set([]),
      exhausted: new Set([]),
      cancelled: new Set([]),
      "manual-required": new Set(["succeeded", "cancelled"]),
    };
    return allowed[from].has(to);
  }

export function enqueueMergeQueueSyncInternalImpl(store: TaskStore, taskId: string, opts: MergeQueueEnqueueOptions): MergeQueueEntry {
    let invalidColumn: Column | null = null;
    const entry = store.db.transactionImmediate(() => {
      const existing = store.db.prepare("SELECT * FROM mergeQueue WHERE taskId = ?").get(taskId) as MergeQueueRow | undefined;
      const taskRow = store.db.prepare("SELECT priority, column FROM tasks WHERE id = ?").get(taskId) as { priority: string | null; column: Column } | undefined;
      if (!taskRow) {
        throw new MergeQueueTaskNotFoundError(taskId);
      }
      if (taskRow.column !== "in-review") {
        invalidColumn = taskRow.column;
        return null;
      }

      const now = opts.now ?? new Date().toISOString();
      const priority = opts.priority ?? normalizeTaskPriority(taskRow.priority);

      let nextEntry: MergeQueueEntry;
      let alreadyEnqueued = true;
      if (existing) {
        nextEntry = store.rowToMergeQueueEntry(existing);
      } else {
        store.db.prepare(`
          INSERT INTO mergeQueue (taskId, enqueuedAt, priority, attemptCount)
          VALUES (?, ?, ?, 0)
          ON CONFLICT(taskId) DO NOTHING
        `).run(taskId, now, priority);
        const inserted = store.db.prepare("SELECT * FROM mergeQueue WHERE taskId = ?").get(taskId) as MergeQueueRow | undefined;
        if (!inserted) {
          throw new Error(`Failed to read merge queue entry for ${taskId} after enqueue`);
        }
        nextEntry = store.rowToMergeQueueEntry(inserted);
        alreadyEnqueued = false;
      }

      store.insertRunAuditEventRow({
        taskId,
        domain: "database",
        mutationType: "mergeQueue:enqueue",
        target: taskId,
        metadata: {
          taskId,
          priority: nextEntry.priority,
          enqueuedAt: nextEntry.enqueuedAt,
          alreadyEnqueued,
        },
      });

      return nextEntry;
    });

    if (invalidColumn) {
      store.db.transactionImmediate(() => {
        store.insertRunAuditEventRow({
          taskId,
          domain: "database",
          mutationType: "mergeQueue:enqueue-rejected",
          target: taskId,
          metadata: {
            taskId,
            column: invalidColumn,
            reason: "not-in-review",
          },
        });
      });
      throw new MergeQueueInvalidColumnError(taskId, invalidColumn);
    }

    if (!entry) {
      throw new Error(`Failed to enqueue merge queue entry for ${taskId}`);
    }
    return entry;
  }

export async function releaseMergeQueueLeaseImpl(store: TaskStore, taskId: string, workerId: string, outcome: MergeQueueReleaseOutcome): Promise<void> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return releaseMergeQueueLeaseAsync(layer, taskId, workerId, outcome);
    }
    store.db.transactionImmediate(() => {
      const current = store.db.prepare("SELECT leasedBy FROM mergeQueue WHERE taskId = ?").get(taskId) as { leasedBy: string | null } | undefined;
      if (!current || current.leasedBy !== workerId) {
        throw new MergeQueueLeaseOwnershipError(taskId, workerId, current?.leasedBy ?? null);
      }

      if (outcome.kind === "success") {
        store.db.prepare("DELETE FROM mergeQueue WHERE taskId = ? AND leasedBy = ?").run(taskId, workerId);
        store.insertRunAuditEventRow({
          taskId,
          domain: "database",
          mutationType: "mergeQueue:lease-released",
          target: taskId,
          metadata: {
            taskId,
            workerId,
            outcome: "success",
          },
        });
        return;
      }

      const released = store.db.prepare(`
        UPDATE mergeQueue
           SET leasedBy = NULL,
               leasedAt = NULL,
               leaseExpiresAt = NULL,
               attemptCount = attemptCount + 1,
               lastError = ?
         WHERE taskId = ? AND leasedBy = ?
         RETURNING *
      `).get(outcome.error, taskId, workerId) as MergeQueueRow | undefined;
      if (!released) {
        throw new MergeQueueLeaseOwnershipError(taskId, workerId, null);
      }

      const entry = store.rowToMergeQueueEntry(released);
      store.insertRunAuditEventRow({
        taskId,
        domain: "database",
        mutationType: "mergeQueue:lease-released",
        target: taskId,
        metadata: {
          taskId,
          workerId,
          outcome: "failure",
          attemptCount: entry.attemptCount,
          error: outcome.error,
        },
      });
    });
  }

export async function collectMergeDetailsImpl(store: TaskStore, _id: string, _branch: string, task: Task, commitMessage: string, mergeTarget?: { branch: string; source: "task-base-branch" | "task-branch-context" | "branch-group-integration" | "project-default" | "legacy-main"; },): Promise<import("../types.js").MergeDetails> {
    const mergedAt = new Date().toISOString();
    let commitSha: string | undefined;
    let filesChanged: number | undefined;
    let insertions: number | undefined;
    let deletions: number | undefined;
    let landedFiles: string[] | undefined;

    const headResult = await store.runGitCommand("git rev-parse HEAD");
    if (headResult.exitCode === 0) {
      commitSha = headResult.stdout.trim() || undefined;
    } else {
      commitSha = undefined;
    }

    const statsResult = await store.runGitCommand("git show --shortstat --format= HEAD");
    if (statsResult.exitCode === 0) {
      const statsOutput = statsResult.stdout.trim();
      const normalized = statsOutput.replace(/\n/g, " ");
      const filesMatch = normalized.match(/(\d+) files? changed/);
      const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
      const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);
      filesChanged = filesMatch ? Number.parseInt(filesMatch[1], 10) : 0;
      insertions = insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0;
      deletions = deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0;
    } else {
      filesChanged = undefined;
      insertions = undefined;
      deletions = undefined;
    }

    if (commitSha) {
      const landedFilesResult = await store.runGitCommand(`git show --name-only --format= "${commitSha}"`);
      if (landedFilesResult.exitCode === 0) {
        const parsedLandedFiles = landedFilesResult.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (parsedLandedFiles.length > 0) {
          landedFiles = Array.from(new Set(parsedLandedFiles));
        }
      }
    }

    return {
      commitSha,
      landedFiles,
      filesChanged,
      insertions,
      deletions,
      mergeCommitMessage: commitMessage,
      mergedAt,
      mergeConfirmed: true,
      prNumber: task.prInfo?.number,
      mergeTargetBranch: mergeTarget?.branch,
      mergeTargetSource: mergeTarget?.source,
      resolutionStrategy: task.mergeDetails?.resolutionStrategy,
      resolutionMethod: task.mergeDetails?.resolutionMethod,
      attemptsMade: task.mergeDetails?.attemptsMade,
      autoResolvedCount: task.mergeDetails?.autoResolvedCount,
    };
  }

export async function applyPrMergedTransitionImpl(store: TaskStore, taskId: string, ctx?: { agentId?: string; runId?: string },): Promise<{ moved: boolean; skipped?: "already-done" | "not-merged" | "wrong-column" | "paused" }> {
    const task = await store.getTask(taskId);
    if (task.column === "done") {
      return { moved: false, skipped: "already-done" };
    }
    if (task.paused) {
      return { moved: false, skipped: "paused" };
    }
    if (task.prInfo?.status !== "merged") {
      return { moved: false, skipped: "not-merged" };
    }
    if (task.column !== "in-review") {
      storeLog.warn(`[store] applyPrMergedTransition skipped for ${taskId}: column=${task.column}`);
      return { moved: false, skipped: "wrong-column" };
    }

    const freshTask = await store.getTask(taskId);
    if (freshTask.column === "done") {
      return { moved: false, skipped: "already-done" };
    }
    if (freshTask.paused) {
      return { moved: false, skipped: "paused" };
    }
    if (freshTask.prInfo?.status !== "merged") {
      return { moved: false, skipped: "not-merged" };
    }
    if (freshTask.column !== "in-review") {
      storeLog.warn(`[store] applyPrMergedTransition skipped for ${taskId}: column=${freshTask.column}`);
      return { moved: false, skipped: "wrong-column" };
    }

    const movedTask = await store.moveTask(taskId, "done", {
      moveSource: "engine",
      preserveProgress: true,
      preserveWorktree: true,
      skipMergeBlocker: true,
    });

    store.emit("task:merged", {
      task: movedTask,
      branch: movedTask.branch ?? movedTask.prInfo?.headBranch ?? freshTask.branch ?? freshTask.prInfo?.headBranch ?? "",
      merged: true,
      worktreeRemoved: false,
      branchDeleted: false,
      mergeConfirmed: movedTask.mergeDetails?.mergeConfirmed ?? freshTask.mergeDetails?.mergeConfirmed,
      mergedAt: movedTask.mergeDetails?.mergedAt ?? freshTask.mergeDetails?.mergedAt,
      mergeTargetBranch: movedTask.mergeDetails?.mergeTargetBranch ?? freshTask.mergeDetails?.mergeTargetBranch,
      mergeTargetSource: movedTask.mergeDetails?.mergeTargetSource ?? freshTask.mergeDetails?.mergeTargetSource,
    } satisfies MergeResult);

    if (ctx?.agentId && ctx?.runId) {
      void store.recordRunAuditEvent({
        taskId,
        agentId: ctx.agentId,
        runId: ctx.runId,
        domain: "database",
        mutationType: "pr:merged-auto-done",
        target: taskId,
        metadata: {
          taskId,
          prNumber: freshTask.prInfo?.number,
          mergeMethod: freshTask.prInfo?.autoMergeStrategy,
        },
      });
    }

    return { moved: true };
  }

