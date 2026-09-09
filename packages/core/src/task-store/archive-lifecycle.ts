/**
 * Task deletion lifecycle operations.
 *
 * FNXC:TaskArchiveRemoval 2026-09-04-10:36:
 * Archive is no longer a task lifecycle. This module retains only soft-delete orchestration; a task
 * is active, complete, or deleted, and completed work remains visible in its completion lane.
 */
import type { TaskStore } from "../store.js";
import { TaskSelfDeleteError } from "./errors.js";
import type { Task, GithubIssueAction } from "../types.js";
import type { TaskDeleteAuditContext } from "../task-delete-attribution.js";

export async function deleteTaskImpl(
  store: TaskStore,
  id: string,
  options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    allowResurrection?: boolean;
    githubIssueAction?: GithubIssueAction;
    auditContext?: TaskDeleteAuditContext;
  },
): Promise<Task> {
  if (options?.auditContext?.taskId === id) {
    throw new TaskSelfDeleteError(id);
  }
  return store.deleteTaskBackend(id, options);
}

export interface DeleteTaskIfResult {
  task: Task;
  deleted: boolean;
}

export async function deleteTaskIfImpl(
  store: TaskStore,
  id: string,
  predicate: (live: Task) => boolean | Promise<boolean>,
  options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    allowResurrection?: boolean;
    githubIssueAction?: GithubIssueAction;
    auditContext?: TaskDeleteAuditContext;
  },
): Promise<DeleteTaskIfResult> {
  if (options?.auditContext?.taskId === id) throw new TaskSelfDeleteError(id);
  return store.deleteTaskIf(id, predicate, options);
}
