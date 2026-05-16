import type { GithubIssueAction, GlobalSettings, ProjectSettings, Task, TaskStore } from "@fusion/core";
import { GitHubClient } from "./github.js";
import { resolveGithubTrackingAuth } from "./github-auth.js";

const TRANSIENT_RETRY_DELAY_MS = 25;

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

function isTransientGitHubError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  const status = (error as Error & { status?: number; statusCode?: number }).status
    ?? (error as Error & { status?: number; statusCode?: number }).statusCode;

  return (typeof status === "number" && status >= 500)
    || message.includes("econn")
    || message.includes("timed out")
    || message.includes("socket hang up");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class GitHubTrackingStateService {
  private readonly defaultStore: TaskStore;
  private readonly listeners = new Map<TaskStore, {
    onTaskMoved: (event: TaskMovedEvent) => void;
    onTaskDeleted: (task: Task, meta?: { githubIssueAction?: GithubIssueAction }) => void;
  }>();
  private started = false;

  constructor(store: TaskStore) {
    this.defaultStore = store;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.attach(this.defaultStore);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const store of this.listeners.keys()) {
      this.detach(store);
    }
  }

  attach(store: TaskStore): void {
    if (this.listeners.has(store)) {
      return;
    }

    const onTaskMoved = (event: TaskMovedEvent): void => {
      void this.handleTaskMoved(store, event);
    };
    const onTaskDeleted = (task: Task, meta?: { githubIssueAction?: GithubIssueAction }): void => {
      void this.handleTaskDeleted(store, task, meta);
    };
    this.listeners.set(store, { onTaskMoved, onTaskDeleted });

    if (this.started) {
      store.on("task:moved", onTaskMoved);
      store.on("task:deleted", onTaskDeleted);
    }
  }

  detach(store: TaskStore): void {
    const handlers = this.listeners.get(store);
    if (!handlers) {
      return;
    }
    store.off("task:moved", handlers.onTaskMoved);
    store.off("task:deleted", handlers.onTaskDeleted);
    this.listeners.delete(store);
  }

  private async handleTaskMoved(store: TaskStore, event: TaskMovedEvent): Promise<void> {
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
      await store.logEntry(
        event.task.id,
        "Failed to update GitHub tracking issue state",
        "Linked issue metadata is incomplete",
      );
      return;
    }

    try {
      const projectSettings = await store.getSettings() as Pick<ProjectSettings, "githubAuthMode" | "githubAuthToken">;
      const globalSettings = (await store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
      const resolution = resolveGithubTrackingAuth({ projectSettings, globalSettings });
      if (!resolution.ok) {
        await store.logEntry(event.task.id, "Skipped GitHub tracking issue state update", resolution.message);
        return;
      }

      const client = resolution.auth.mode === "token"
        ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
        : new GitHubClient({ forceMode: "gh-cli" });

      if (decision.action === "close") {
        const existing = await client.getIssue(owner, repo, number);
        if (existing?.state === "closed") {
          await store.logEntry(event.task.id, "Linked GitHub tracking issue already closed", `${owner}/${repo}#${number}`);
          return;
        }
      }

      const updateIssueState = async () => {
        await client.setIssueState(
          owner,
          repo,
          number,
          decision.action === "close" ? "closed" : "open",
          decision.stateReason,
        );
      };

      try {
        await updateIssueState();
      } catch (error) {
        if (!isTransientGitHubError(error)) {
          throw error;
        }
        await delay(TRANSIENT_RETRY_DELAY_MS);
        await updateIssueState();
      }

      await store.logEntry(
        event.task.id,
        decision.action === "close"
          ? "Closed linked GitHub tracking issue"
          : "Reopened linked GitHub tracking issue",
        `${owner}/${repo}#${number}`,
      );
    } catch (err) {
      await store.logEntry(
        event.task.id,
        decision.action === "close"
          ? "Failed to close GitHub tracking issue"
          : "Failed to reopen GitHub tracking issue",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async handleTaskDeleted(store: TaskStore, task: Task, meta?: { githubIssueAction?: GithubIssueAction }): Promise<void> {
    if (task.githubTracking?.enabled !== true) {
      return;
    }

    const issue = task.githubTracking.issue;
    if (!issue) {
      return;
    }

    const { owner, repo, number } = issue;
    if (!owner || !repo || !number) {
      return;
    }

    const githubIssueAction = meta?.githubIssueAction ?? "auto";
    if (githubIssueAction === "leave") {
      await store.logEntry(task.id, "Left linked GitHub tracking issue unchanged on task delete", `${owner}/${repo}#${number}`);
      return;
    }

    const projectSettings = await store.getSettings() as Pick<ProjectSettings, "githubAuthMode" | "githubAuthToken">;
    const globalSettings = (await store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
    const resolution = resolveGithubTrackingAuth({ projectSettings, globalSettings });
    if (!resolution.ok) {
      return;
    }

    const client = resolution.auth.mode === "token"
      ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
      : new GitHubClient({ forceMode: "gh-cli" });

    if (githubIssueAction === "delete") {
      try {
        await client.deleteIssue(owner, repo, number);
        await store.logEntry(task.id, "Deleted linked GitHub tracking issue", `${owner}/${repo}#${number}`);
      } catch (err) {
        await store.logEntry(task.id, "Failed to delete linked GitHub tracking issue", err instanceof Error ? err.message : String(err));
      }
      return;
    }

    try {
      await client.setIssueState(owner, repo, number, "closed", "not_planned");
    } catch (err) {
      await store.logEntry(task.id, "Failed to close linked GitHub tracking issue", err instanceof Error ? err.message : String(err));
    }
  }
}
