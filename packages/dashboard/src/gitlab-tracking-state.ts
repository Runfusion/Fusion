import type { Task, TaskStore } from "@fusion/core";
import { GitLabApiError } from "./gitlab.js";
import { resolveGitLabClient, resolveGitLabTargetFromItem, safeLogGitLabEntry, type GitLabLifecycleTarget } from "./gitlab-lifecycle.js";
import { decideIssueAction, delay } from "./github-tracking-state.js";

const TRANSIENT_RETRY_DELAY_MS = 25;

interface TaskMovedEvent { task: Task; from: string; to: string; }

export function isTransientGitLabError(error: unknown): boolean {
  if (error instanceof GitLabApiError && error.status >= 500) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("econn") || message.includes("timed out") || message.includes("socket hang up");
}

async function retryTransient<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (error) {
    if (!isTransientGitLabError(error)) throw error;
    await delay(TRANSIENT_RETRY_DELAY_MS);
    return await fn();
  }
}

export class GitLabTrackingStateService {
  private readonly defaultStore: TaskStore;
  private readonly listeners = new Map<TaskStore, { onTaskMoved: (event: TaskMovedEvent) => void }>();
  private started = false;

  constructor(store: TaskStore) { this.defaultStore = store; }

  start(): void { if (this.started) return; this.started = true; this.attach(this.defaultStore); }
  stop(): void { if (!this.started) return; this.started = false; for (const store of this.listeners.keys()) this.detach(store); }

  attach(store: TaskStore): void {
    if (this.listeners.has(store)) return;
    const onTaskMoved = (event: TaskMovedEvent): void => { void this.handleTaskMoved(store, event); };
    this.listeners.set(store, { onTaskMoved });
    if (this.started) store.on("task:moved", onTaskMoved);
  }

  detach(store: TaskStore): void {
    const handlers = this.listeners.get(store);
    if (!handlers) return;
    store.off("task:moved", handlers.onTaskMoved);
    this.listeners.delete(store);
  }

  private async handleTaskMoved(store: TaskStore, event: TaskMovedEvent): Promise<void> {
    const decision = decideIssueAction(event.from, event.to);
    if (!decision) return;
    const item = event.task.gitlabTracking?.item;
    if (!item) return;
    const target = resolveGitLabTargetFromItem(item);
    if (!target) {
      await safeLogGitLabEntry(store, event.task.id, "Failed to update GitLab tracking state", "Linked GitLab metadata is incomplete");
      return;
    }
    await updateGitLabTargetState(store, event.task.id, target, decision.action === "close" ? "closed" : "opened", "tracking");
  }
}

export async function updateGitLabTargetState(store: TaskStore, taskId: string, target: GitLabLifecycleTarget, state: "opened" | "closed", source: "tracking" | "source"): Promise<void> {
  const action = state === "closed" ? "close" : "reopen";
  try {
    const resolved = await resolveGitLabClient(store);
    if (!resolved.ok) {
      await safeLogGitLabEntry(store, taskId, `Skipped ${action === "close" ? "closing" : "reopening"} GitLab ${source} ${target.kind === "merge_request" ? "merge request" : "issue"}`, resolved.message);
      return;
    }

    if (target.kind === "merge_request") {
      const existing = await resolved.client.getMergeRequest(target.project, target.iid);
      if (existing.state === "merged") {
        await safeLogGitLabEntry(store, taskId, "Skipped closing GitLab merge request", `${target.label} is merged and cannot be auto-closed`);
        return;
      }
      if (existing.state === state) {
        await safeLogGitLabEntry(store, taskId, `Skipped ${action === "close" ? "closing" : "reopening"} GitLab merge request`, `${target.label} already ${state}`);
        return;
      }
      await retryTransient(() => resolved.client.setMergeRequestState(target.project, target.iid, state));
      await safeLogGitLabEntry(store, taskId, `${action === "close" ? "Closed" : "Reopened"} linked GitLab ${source} merge request`, target.label);
      return;
    }

    const existing = await resolved.client.getProjectIssue(target.project, target.iid);
    if (existing.state === state) {
      await safeLogGitLabEntry(store, taskId, `Skipped ${action === "close" ? "closing" : "reopening"} GitLab issue`, `${target.label} already ${state}`);
      return;
    }
    await retryTransient(() => resolved.client.setProjectIssueState(target.project, target.iid, state));
    await safeLogGitLabEntry(store, taskId, `${action === "close" ? "Closed" : "Reopened"} linked GitLab ${source} issue`, target.label);
  } catch (error) {
    await safeLogGitLabEntry(store, taskId, `Failed to ${action} GitLab ${source} ${target.kind === "merge_request" ? "merge request" : "issue"}`, error instanceof Error ? error.message : String(error));
  }
}
