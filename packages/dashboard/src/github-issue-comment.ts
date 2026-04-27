import type { TaskStore } from "@fusion/core";
import { GitHubClient } from "./github.js";

interface TaskMovedEvent {
  task: {
    id: string;
    title?: string;
    sourceIssue?: {
      provider: string;
      repository: string;
      issueNumber: number;
    };
  };
  to: string;
}

const DEFAULT_COMMENT_TEMPLATE = "✅ Task {taskId} ({taskTitle}) has been completed and resolved.";

export class GitHubIssueCommentService {
  private readonly store: TaskStore;
  private readonly getGitHubToken: () => string | undefined;
  private readonly onTaskMoved = (event: TaskMovedEvent): void => {
    void this.handleTaskMoved(event);
  };
  private started = false;

  constructor(store: TaskStore, getGitHubToken?: () => string | undefined) {
    this.store = store;
    this.getGitHubToken = getGitHubToken ?? (() => process.env.GITHUB_TOKEN);
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
    if (event.to !== "done") {
      return;
    }

    const task = event.task;
    const settings = await this.store.getSettings();
    if (!settings.githubCommentOnDone) {
      return;
    }

    const sourceIssue = task.sourceIssue;
    if (!sourceIssue || sourceIssue.provider !== "github") {
      return;
    }

    const [owner, repo] = sourceIssue.repository.split("/");
    if (!owner || !repo) {
      await this.store.logEntry(
        task.id,
        "Failed to post GitHub issue comment",
        `Invalid GitHub repository format: ${sourceIssue.repository}`,
      );
      return;
    }

    const template = settings.githubCommentTemplate || DEFAULT_COMMENT_TEMPLATE;
    const commentBody = template
      .replaceAll("{taskId}", task.id)
      .replaceAll("{taskTitle}", task.title ?? "");

    try {
      const client = new GitHubClient(this.getGitHubToken());
      await client.commentOnIssue(owner, repo, sourceIssue.issueNumber, commentBody);
      await this.store.logEntry(
        task.id,
        "Posted GitHub issue completion comment",
        `${sourceIssue.repository}#${sourceIssue.issueNumber}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.logEntry(
        task.id,
        "Failed to post GitHub issue comment",
        message,
      );
    }
  }
}

export { DEFAULT_COMMENT_TEMPLATE };
