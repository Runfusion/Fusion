import type { GlobalSettings, ProjectSettings, Task, TaskStore } from "@fusion/core";
import { GitHubClient } from "./github.js";
import { resolveGithubTrackingAuth } from "./github-auth.js";

const COMMENT_MAX_LENGTH = 500;

interface TaskMovedEvent {
  task: Task;
  from: string;
  to: string;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function formatTrackingComment(
  task: Pick<Task, "id" | "title">,
  transition: "in-progress" | "done",
): string {
  const prefix = `Fusion task: ${task.id}\n\n`;
  const stem = transition === "in-progress"
    ? "🚧 In progress — work has started on “"
    : "✅ Done — “";
  const suffix = transition === "in-progress" ? "”." : "” is complete.";

  const rawTitle = collapseWhitespace(task.title ?? "") || "Untitled task";
  const available = COMMENT_MAX_LENGTH - prefix.length - stem.length - suffix.length;
  const title = rawTitle.length <= available
    ? rawTitle
    : `${rawTitle.slice(0, Math.max(0, available - 1)).trimEnd()}…`;

  return `${prefix}${stem}${title}${suffix}`;
}

export class GitHubTrackingCommentService {
  private readonly store: TaskStore;
  private readonly onTaskMoved = (event: TaskMovedEvent): void => {
    void this.handleTaskMoved(event);
  };
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
    if (event.from === event.to) {
      return;
    }

    if (event.to !== "in-progress" && event.to !== "done") {
      return;
    }

    if (event.task.githubTracking?.enabled !== true) {
      return;
    }

    const issue = event.task.githubTracking?.issue;
    if (!issue) {
      return;
    }

    const { owner, repo, number } = issue;
    if (!owner || !repo || !number) {
      await this.store.logEntry(
        event.task.id,
        "Failed to post GitHub tracking comment",
        "Linked issue metadata is incomplete",
      );
      return;
    }

    const body = formatTrackingComment(event.task, event.to);

    try {
      const projectSettings = await this.store.getSettings() as Pick<ProjectSettings, "githubAuthMode" | "githubAuthToken">;
      const globalSettings = (await this.store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
      const resolution = resolveGithubTrackingAuth({ projectSettings, globalSettings });
      if (!resolution.ok) {
        await this.store.logEntry(event.task.id, "Skipped GitHub tracking comment", resolution.message);
        return;
      }

      const client = resolution.auth.mode === "token"
        ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
        : new GitHubClient({ forceMode: "gh-cli" });
      await client.commentOnIssue(owner, repo, number, body);
      await this.store.logEntry(
        event.task.id,
        "Posted GitHub tracking comment",
        `${owner}/${repo}#${number} (${event.to})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.logEntry(
        event.task.id,
        "Failed to post GitHub tracking comment",
        message,
      );
    }
  }
}
