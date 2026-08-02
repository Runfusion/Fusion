import type { Task, TaskDeleteClosureContext, TaskStore } from "@fusion/core";
import { resolveGitLabClient, resolveGitLabTarget, safeLogGitLabEntry, type GitLabLifecycleTarget } from "./gitlab-lifecycle.js";
import { retryTransient, updateGitLabTargetState } from "./gitlab-tracking-state.js";

type TaskDeletedMeta = {
  closureContext?: TaskDeleteClosureContext | { kind?: string; childTaskIds?: unknown };
  observed?: boolean;
};

export type GitLabSplitNoteResult =
  | { status: "posted"; target: GitLabLifecycleTarget }
  | { status: "no-op"; reason: "no-closure-context" | "not-split" | "empty-child-ids" | "no-target" | "merge-request-target" | "already-closed" | "auth-unresolved" }
  | { status: "failed"; reason: "comment-post-failed"; error: unknown };

/*
FNXC:GitLabSplitClose 2026-08-01-09:58:
Split-close gives the source issue a durable handoff: one note names the parent and normalized child task IDs immediately before one close. resolveGitLabTarget() makes a valid tracking item the owner; malformed tracking stays inert here so split-close cannot newly mutate a source item. Identity is by construction and one item cannot receive duplicate notes.

Empty or blank child IDs leave no self-explanatory handoff and are a no-op; duplicate IDs retain their first occurrence only. The typed posted | no-op | failed result deliberately gates the caller: only posted may close the returned target, so a note failure or benign non-owner state can never close an issue without its explanatory note.
*/
export function normalizeGitLabSplitChildTaskIds(childTaskIds: readonly string[]): string[] {
  const seen = new Set<string>();
  return childTaskIds.filter((childTaskId) => {
    if (!childTaskId.trim() || seen.has(childTaskId)) return false;
    seen.add(childTaskId);
    return true;
  });
}

export function buildGitLabSplitCloseNote(taskId: string, childTaskIds: readonly string[]): string | null {
  const childIds = normalizeGitLabSplitChildTaskIds(childTaskIds);
  if (childIds.length === 0) return null;
  return `This issue was imported as Fusion task ${taskId}, which has been broken down into subtasks: ${childIds.join(", ")}. Closing this issue; work continues in those tasks.`;
}

export async function postGitLabSplitNoteBeforeClose(store: TaskStore, task: Task, meta?: TaskDeletedMeta): Promise<GitLabSplitNoteResult> {
  const closureContext = meta?.closureContext;
  if (!closureContext) return { status: "no-op", reason: "no-closure-context" };
  if (closureContext.kind !== "split-into-subtasks") return { status: "no-op", reason: "not-split" };

  const body = buildGitLabSplitCloseNote(task.id, Array.isArray(closureContext.childTaskIds) ? closureContext.childTaskIds : []);
  if (!body) return { status: "no-op", reason: "empty-child-ids" };

  const target = resolveGitLabTarget(task);
  if (!target) return { status: "no-op", reason: "no-target" };
  if (target.kind === "merge_request") {
    await safeLogGitLabEntry(store, task.id, "Skipped GitLab split-close note", `${target.label} is a merge request and is not auto-closed on task split`);
    return { status: "no-op", reason: "merge-request-target" };
  }

  const resolved = await resolveGitLabClient(store);
  if (!resolved.ok) return { status: "no-op", reason: "auth-unresolved" };

  try {
    const existing = await resolved.client.getProjectIssue(target.project, target.iid);
    if (existing.state === "closed") return { status: "no-op", reason: "already-closed" };
    await retryTransient(() => resolved.client.commentOnProjectIssue(target.project, target.iid, body));
    await safeLogGitLabEntry(store, task.id, "Posted GitLab split-close note", target.label);
    return { status: "posted", target };
  } catch (error) {
    return { status: "failed", reason: "comment-post-failed", error };
  }
}

export class GitLabSplitCloseService {
  private readonly defaultStore: TaskStore;
  private readonly listeners = new Map<TaskStore, { onTaskDeleted: (task: Task, meta?: TaskDeletedMeta) => void }>();
  private started = false;

  constructor(store: TaskStore) { this.defaultStore = store; }

  start(): void { if (this.started) return; this.started = true; this.attach(this.defaultStore); }
  stop(): void { if (!this.started) return; this.started = false; for (const store of [...this.listeners.keys()]) this.detach(store); }

  attach(store: TaskStore): void {
    if (this.listeners.has(store)) return;
    const onTaskDeleted = (task: Task, meta?: TaskDeletedMeta): void => { void this.handleTaskDeleted(store, task, meta); };
    this.listeners.set(store, { onTaskDeleted });
    if (this.started) store.on("task:deleted", onTaskDeleted);
  }

  detach(store: TaskStore): void {
    const handlers = this.listeners.get(store);
    if (!handlers) return;
    store.off("task:deleted", handlers.onTaskDeleted);
    this.listeners.delete(store);
  }

  private async handleTaskDeleted(store: TaskStore, task: Task, meta?: TaskDeletedMeta): Promise<void> {
    /* FNXC:CrossProcessDeleteObservation 2026-08-01-13:03: Split notes are writer-owned and must not repeat on at-least-once observed delivery. */
    if (meta?.observed) return;
    try {
      const result = await postGitLabSplitNoteBeforeClose(store, task, meta);
      if (result.status === "posted") {
        await updateGitLabTargetState(store, task.id, result.target, "closed", "split-close");
      } else if (result.status === "failed") {
        await safeLogGitLabEntry(store, task.id, "Failed to post GitLab split-close note", result.error instanceof Error ? result.error.message : String(result.error));
      }
    } catch (error) {
      await safeLogGitLabEntry(store, task.id, "Failed to process GitLab split-close", error instanceof Error ? error.message : String(error));
    }
  }
}
