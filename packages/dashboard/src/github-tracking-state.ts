import type { GithubIssueAction, GlobalSettings, ProjectSettings, Task, TaskStore } from "@fusion/core";
import { GitHubClient } from "./github.js";
import { resolveGithubTrackingAuth } from "./github-auth.js";

const TRANSIENT_RETRY_DELAY_MS = 25;

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
  // #1403: the store's `task:moved` event carries `ColumnId` (custom column ids
  // admitted). U12 re-keys the decision on the complete/archived traits, so a
  // workflow-defined terminal column maps to GitHub state like `done` does.
  from: string;
  to: string;
}

/*
FNXC:WorkflowColumns 2026-07-19-2b:50 (U12 / R2):
GitHub open/closed state keys on the `complete` and `archived` TRAITS, not the literal ids `done`
and `archived`. A user-authored workflow whose terminal column is called something else never
closed its linked GitHub issue, and a custom archive column never mapped to `not_planned`.

`classify` is injected rather than resolved here so this stays a pure decision function (the
caller owns IR resolution). Its default reproduces the legacy literal mapping exactly, so every
existing caller and the default workflow are byte-identical.
*/
export interface ColumnLifecycleClass {
  complete: boolean;
  archived: boolean;
}

export const legacyColumnLifecycleClass = (columnId: string): ColumnLifecycleClass => ({
  complete: columnId === "done",
  archived: columnId === "archived",
});

export function decideIssueAction(
  from: string,
  to: string,
  classify: (columnId: string) => ColumnLifecycleClass = legacyColumnLifecycleClass,
): { action: "close" | "reopen"; stateReason: "completed" | "not_planned" | "reopened" } | null {
  const fromClass = classify(from);
  const toClass = classify(to);

  // Un-archiving back into the completed column re-opens the issue.
  if (fromClass.archived && toClass.complete) {
    return { action: "reopen", stateReason: "reopened" };
  }

  if (toClass.complete && !fromClass.complete) {
    return { action: "close", stateReason: "completed" };
  }

  if (toClass.archived) {
    if (fromClass.complete) {
      return { action: "close", stateReason: "completed" };
    }
    if (!fromClass.archived) {
      return { action: "close", stateReason: "not_planned" };
    }
    return null;
  }

  // Leaving the completed column re-opens the issue.
  if (fromClass.complete && !toClass.complete) {
    return { action: "reopen", stateReason: "reopened" };
  }

  return null;
}

export function isTransientGitHubError(error: unknown): boolean {
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

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type GitHubIssueActionEvent = {
  taskId: string;
  action: "close" | "reopen" | "delete" | "leave";
  owner: string;
  repo: string;
  number: number;
  outcome: "success" | "failed" | "skipped";
  error?: string;
};

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
      await this.safeLogDeletedTaskEntry(
        store,
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
        await this.safeLogDeletedTaskEntry(store, event.task.id, "Skipped GitHub tracking issue state update", resolution.message);
        return;
      }

      const client = resolution.auth.mode === "token"
        ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
        : new GitHubClient({ forceMode: "gh-cli" });

      if (decision.action === "close") {
        const existing = await client.getIssue(owner, repo, number);
        if (existing?.state === "closed") {
          await this.safeLogDeletedTaskEntry(store, event.task.id, "Linked GitHub tracking issue already closed", `${owner}/${repo}#${number}`);
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

      await this.safeLogDeletedTaskEntry(
        store,
        event.task.id,
        decision.action === "close"
          ? "Closed linked GitHub tracking issue"
          : "Reopened linked GitHub tracking issue",
        `${owner}/${repo}#${number}`,
      );
    } catch (err) {
      await this.safeLogDeletedTaskEntry(
        store,
        event.task.id,
        decision.action === "close"
          ? "Failed to close GitHub tracking issue"
          : "Failed to reopen GitHub tracking issue",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private emitGitHubIssueAction(store: TaskStore, event: GitHubIssueActionEvent): void {
    (store as unknown as { emit: (eventName: string, payload: GitHubIssueActionEvent) => void }).emit("github-issue:action", event);
  }

  private async safeLogDeletedTaskEntry(store: TaskStore, taskId: string, message: string, details: string): Promise<void> {
    try {
      await store.logEntry(taskId, message, details);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes(`Task ${taskId} not found`)) {
        console.warn(`[github-tracking-state] Unable to write log entry for deleted task ${taskId}: ${message}`);
        return;
      }
      throw error;
    }
  }

  private async handleSourceIssueDelete(store: TaskStore, task: Task, meta?: { githubIssueAction?: GithubIssueAction }): Promise<void> {
    const sourceIssue = task.sourceIssue;
    if (sourceIssue?.provider !== "github") {
      return;
    }

    const [owner, repo, extra] = sourceIssue.repository.split("/");
    if (!owner || !repo || extra) {
      await this.safeLogDeletedTaskEntry(
        store,
        task.id,
        "Failed to close linked source GitHub issue",
        `Invalid source issue repository: ${sourceIssue.repository}`,
      );
      return;
    }

    const number = sourceIssue.issueNumber;
    if (!Number.isInteger(number) || number <= 0) {
      await this.safeLogDeletedTaskEntry(
        store,
        task.id,
        "Failed to close linked source GitHub issue",
        `Invalid source issue number: ${String(number)}`,
      );
      return;
    }

    const githubIssueAction = meta?.githubIssueAction ?? "auto";
    // Source-imported issues represent real incoming work; if no explicit action is provided,
    // deleting the task defaults to closing the source issue.
    const resolvedAction = githubIssueAction === "auto" ? "close" : githubIssueAction;
    if (resolvedAction === "leave") {
      await this.safeLogDeletedTaskEntry(store, task.id, "Left linked source GitHub issue unchanged on task delete", `${owner}/${repo}#${number}`);
      this.emitGitHubIssueAction(store, { taskId: task.id, action: "leave", owner, repo, number, outcome: "skipped" });
      return;
    }

    const projectSettings = await store.getSettings() as Pick<ProjectSettings, "githubAuthMode" | "githubAuthToken">;
    const globalSettings = (await store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
    const resolution = resolveGithubTrackingAuth({ projectSettings, globalSettings });
    if (!resolution.ok) {
      this.emitGitHubIssueAction(store, {
        taskId: task.id,
        action: resolvedAction === "delete" ? "delete" : "close",
        owner,
        repo,
        number,
        outcome: "failed",
        error: resolution.message,
      });
      return;
    }

    const client = resolution.auth.mode === "token"
      ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
      : new GitHubClient({ forceMode: "gh-cli" });

    if (resolvedAction === "delete") {
      try {
        const deleteIssue = async () => {
          await client.deleteIssue(owner, repo, number);
        };
        try {
          await deleteIssue();
        } catch (error) {
          if (!isTransientGitHubError(error)) {
            throw error;
          }
          await delay(TRANSIENT_RETRY_DELAY_MS);
          await deleteIssue();
        }

        await this.safeLogDeletedTaskEntry(store, task.id, "Deleted linked source GitHub issue", `${owner}/${repo}#${number}`);
        this.emitGitHubIssueAction(store, { taskId: task.id, action: "delete", owner, repo, number, outcome: "success" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emitGitHubIssueAction(store, { taskId: task.id, action: "delete", owner, repo, number, outcome: "failed", error: message });
        await this.safeLogDeletedTaskEntry(store, task.id, "Failed to delete linked source GitHub issue", message);
      }
      return;
    }

    try {
      const existing = await client.getIssue(owner, repo, number);
      if (existing?.state === "closed") {
        await this.safeLogDeletedTaskEntry(store, task.id, "Linked source GitHub issue already closed", `${owner}/${repo}#${number}`);
        this.emitGitHubIssueAction(store, { taskId: task.id, action: "close", owner, repo, number, outcome: "skipped" });
        return;
      }

      const closeIssue = async () => {
        // Source-imported issues map to completed work, so closure reason is "completed".
        await client.setIssueState(owner, repo, number, "closed", "completed");
      };

      try {
        await closeIssue();
      } catch (error) {
        if (!isTransientGitHubError(error)) {
          throw error;
        }
        await delay(TRANSIENT_RETRY_DELAY_MS);
        await closeIssue();
      }

      await this.safeLogDeletedTaskEntry(store, task.id, "Closed linked source GitHub issue", `${owner}/${repo}#${number}`);
      this.emitGitHubIssueAction(store, { taskId: task.id, action: "close", owner, repo, number, outcome: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitGitHubIssueAction(store, { taskId: task.id, action: "close", owner, repo, number, outcome: "failed", error: message });
      await this.safeLogDeletedTaskEntry(store, task.id, "Failed to close linked source GitHub issue", message);
    }
  }

  private async handleTaskDeleted(store: TaskStore, task: Task, meta?: { githubIssueAction?: GithubIssueAction }): Promise<void> {
    if (task.githubTracking?.enabled !== true) {
      await this.handleSourceIssueDelete(store, task, meta);
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
      await this.safeLogDeletedTaskEntry(store, task.id, "Left linked GitHub tracking issue unchanged on task delete", `${owner}/${repo}#${number}`);
      this.emitGitHubIssueAction(store, { taskId: task.id, action: "leave", owner, repo, number, outcome: "skipped" });
      return;
    }

    const projectSettings = await store.getSettings() as Pick<ProjectSettings, "githubAuthMode" | "githubAuthToken">;
    const globalSettings = (await store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
    const resolution = resolveGithubTrackingAuth({ projectSettings, globalSettings });
    if (!resolution.ok) {
      this.emitGitHubIssueAction(store, {
        taskId: task.id,
        action: githubIssueAction === "delete" ? "delete" : "close",
        owner,
        repo,
        number,
        outcome: "failed",
        error: resolution.message,
      });
      return;
    }

    const client = resolution.auth.mode === "token"
      ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
      : new GitHubClient({ forceMode: "gh-cli" });

    if (githubIssueAction === "delete") {
      try {
        const deleteIssue = async () => {
          await client.deleteIssue(owner, repo, number);
        };
        try {
          await deleteIssue();
        } catch (error) {
          if (!isTransientGitHubError(error)) {
            throw error;
          }
          await delay(TRANSIENT_RETRY_DELAY_MS);
          await deleteIssue();
        }

        await this.safeLogDeletedTaskEntry(store, task.id, "Deleted linked GitHub tracking issue", `${owner}/${repo}#${number}`);
        this.emitGitHubIssueAction(store, { taskId: task.id, action: "delete", owner, repo, number, outcome: "success" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emitGitHubIssueAction(store, { taskId: task.id, action: "delete", owner, repo, number, outcome: "failed", error: message });
        await this.safeLogDeletedTaskEntry(store, task.id, "Failed to delete linked GitHub tracking issue", message);
      }
      return;
    }

    try {
      const existing = await client.getIssue(owner, repo, number);
      if (existing?.state === "closed") {
        await this.safeLogDeletedTaskEntry(store, task.id, "Linked GitHub tracking issue already closed", `${owner}/${repo}#${number}`);
        this.emitGitHubIssueAction(store, { taskId: task.id, action: "close", owner, repo, number, outcome: "skipped" });
        return;
      }

      const closeIssue = async () => {
        await client.setIssueState(owner, repo, number, "closed", "not_planned");
      };

      try {
        await closeIssue();
      } catch (error) {
        if (!isTransientGitHubError(error)) {
          throw error;
        }
        await delay(TRANSIENT_RETRY_DELAY_MS);
        await closeIssue();
      }

      await this.safeLogDeletedTaskEntry(store, task.id, "Closed linked GitHub tracking issue", `${owner}/${repo}#${number}`);
      this.emitGitHubIssueAction(store, { taskId: task.id, action: "close", owner, repo, number, outcome: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitGitHubIssueAction(store, { taskId: task.id, action: "close", owner, repo, number, outcome: "failed", error: message });
      await this.safeLogDeletedTaskEntry(store, task.id, "Failed to close linked GitHub tracking issue", message);
    }
  }
}
