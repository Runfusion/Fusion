import type { ProjectSettings, Task, TaskStore } from "@fusion/core";
import { resolveGitLabTarget, safeLogGitLabEntry } from "./gitlab-lifecycle.js";
import { updateGitLabTargetState } from "./gitlab-tracking-state.js";
import { decideIssueAction } from "./github-tracking-state.js";

interface TaskMovedEvent { task: Task; from: string; to: string; }

export class GitLabSourceIssueCloseService {
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
    const settings = await store.getSettings() as Pick<ProjectSettings, "gitlabCloseSourceIssueOnDone">;
    if (settings.gitlabCloseSourceIssueOnDone !== true) return;
    if (event.task.sourceIssue?.provider !== "gitlab") return;
    const decision = decideIssueAction(event.from, event.to);
    if (!decision) return;
    const target = resolveGitLabTarget(event.task);
    if (!target) {
      await safeLogGitLabEntry(store, event.task.id, "Skipped closing GitLab source issue", "Linked GitLab source metadata is incomplete");
      return;
    }
    await updateGitLabTargetState(store, event.task.id, target, decision.action === "close" ? "closed" : "opened", "source");
  }
}
