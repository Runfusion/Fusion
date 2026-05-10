import type { GlobalSettings, ProjectSettings, TaskStore } from "@fusion/core";
import { GitHubClient } from "./github.js";
import { resolveGithubTrackingAuth } from "./github-auth.js";

type Column = "triage" | "todo" | "in-progress" | "in-review" | "done" | "archived";

interface TaskMovedEvent {
  task: {
    id: string;
    githubTracking?: {
      enabled?: boolean;
      issue?: {
        owner?: string;
        repo?: string;
        number?: number;
        url?: string;
        htmlUrl?: string;
        createdAt?: string;
      };
    };
  };
  from: Column;
  to: Column;
}

export function decideIssueAction(
  from: Column,
  to: Column,
): { action: "close" | "reopen"; stateReason: "completed" | "reopened" } | null {
  if (to === "done" && from !== "done") {
    return { action: "close", stateReason: "completed" };
  }

  if (from === "done" && to !== "done" && to !== "archived") {
    return { action: "reopen", stateReason: "reopened" };
  }

  return null;
}

export class GitHubTrackingStateService {
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
    const decision = decideIssueAction(event.from, event.to);
    if (!decision) {
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
        "Failed to update GitHub tracking issue state",
        "Linked issue metadata is incomplete",
      );
      return;
    }

    try {
      const projectSettings = await this.store.getSettings() as Pick<ProjectSettings, "githubAuthMode" | "githubAuthToken">;
      const globalSettings = (await this.store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
      const resolution = resolveGithubTrackingAuth({ projectSettings, globalSettings });
      if (!resolution.ok) {
        await this.store.logEntry(event.task.id, "Skipped GitHub tracking issue state update", resolution.message);
        return;
      }

      const client = resolution.auth.mode === "token"
        ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
        : new GitHubClient({ forceMode: "gh-cli" });

      await client.setIssueState(
        owner,
        repo,
        number,
        decision.action === "close" ? "closed" : "open",
        decision.stateReason,
      );
      await this.store.logEntry(
        event.task.id,
        decision.action === "close"
          ? "Closed linked GitHub tracking issue"
          : "Reopened linked GitHub tracking issue",
        `${owner}/${repo}#${number}`,
      );
    } catch (err) {
      await this.store.logEntry(
        event.task.id,
        decision.action === "close"
          ? "Failed to close GitHub tracking issue"
          : "Failed to reopen GitHub tracking issue",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
