import type { ProjectSettings, Task, TaskStore } from "@fusion/core";
import { resolveGitLabClient, resolveGitLabTarget, safeLogGitLabEntry } from "./gitlab-lifecycle.js";

interface TaskMovedEvent {
  task: Task;
  to: string;
}

export const DEFAULT_GITLAB_COMMENT_TEMPLATE = "✅ Task {taskId} ({taskTitle}) has been completed and resolved.";

export class GitLabIssueCommentService {
  private readonly store: TaskStore;
  private readonly onTaskMoved = (event: TaskMovedEvent): void => { void this.handleTaskMoved(event); };
  private started = false;

  constructor(store: TaskStore) {
    this.store = store;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.store.on("task:moved", this.onTaskMoved);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.store.off("task:moved", this.onTaskMoved);
  }

  private async handleTaskMoved(event: TaskMovedEvent): Promise<void> {
    if (event.to !== "done" || event.task.sourceIssue?.provider !== "gitlab") return;
    const settings = await this.store.getSettings() as Pick<ProjectSettings, "gitlabCommentOnDone" | "gitlabCommentTemplate">;
    if (settings.gitlabCommentOnDone !== true) return;

    const target = resolveGitLabTarget(event.task);
    if (!target) {
      await safeLogGitLabEntry(this.store, event.task.id, "Skipped GitLab source comment", "Linked GitLab source metadata is incomplete");
      return;
    }

    const template = settings.gitlabCommentTemplate || DEFAULT_GITLAB_COMMENT_TEMPLATE;
    const body = template.replaceAll("{taskId}", event.task.id).replaceAll("{taskTitle}", event.task.title ?? "");

    try {
      const resolved = await resolveGitLabClient(this.store);
      if (!resolved.ok) {
        await safeLogGitLabEntry(this.store, event.task.id, "Skipped GitLab source comment", resolved.message);
        return;
      }
      if (target.kind === "merge_request") {
        await resolved.client.commentOnMergeRequest(target.project, target.iid, body);
      } else {
        await resolved.client.commentOnProjectIssue(target.project, target.iid, body);
      }
      await safeLogGitLabEntry(this.store, event.task.id, "Posted GitLab issue completion comment", target.label);
    } catch (error) {
      await safeLogGitLabEntry(this.store, event.task.id, "Failed to post GitLab issue comment", error instanceof Error ? error.message : String(error));
    }
  }
}
