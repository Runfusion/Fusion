import { createLogger, type GlobalSettings, type ProjectSettings, type TaskStore } from "@fusion/core";
import { reportTaskListenerFailure, safeLogTaskEntry } from "./task-log-safety.js";

const terminalTaskWriteLog = createLogger("github-source-issue-close");
import { resolveGithubTrackingAuth } from "./github-auth.js";
import { GitHubClient } from "./github.js";
import { decideIssueAction, delay, isTransientGitHubError } from "./github-tracking-state.js";

interface TaskMovedEvent {
  task: {
    id: string;
    sourceIssue?: {
      provider?: string;
      repository?: string;
      issueNumber?: number;
    };
  };
  // #1403: store's `task:moved` carries `ColumnId`; this handler only
  // literal-compares legacy ids, so the widened string field is safe.
  from: string;
  to: string;
}

export class GitHubSourceIssueCloseService {
  private readonly defaultStore: TaskStore;
  private readonly listeners = new Map<TaskStore, { onTaskMoved: (event: TaskMovedEvent) => void }>();
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
      void this.handleTaskMoved(store, event).catch((error) => reportTaskListenerFailure(terminalTaskWriteLog, "github-source-issue-close", error));
    };
    this.listeners.set(store, { onTaskMoved });

    if (this.started) {
      store.on("task:moved", onTaskMoved);
    }
  }

  detach(store: TaskStore): void {
    const handlers = this.listeners.get(store);
    if (!handlers) {
      return;
    }
    store.off("task:moved", handlers.onTaskMoved);
    this.listeners.delete(store);
  }

  /*
  FNXC:TerminalTaskWrites 2026-09-15-21:55:
  A move snapshot can become archived before any source-issue outcome is logged. Route every outcome
  through the canonical refusal-aware seam so terminal rows remain read-only without hiding other errors.
  */
  private async handleTaskMoved(store: TaskStore, event: TaskMovedEvent): Promise<void> {
    const settings = ((await store.getSettings()) ?? {}) as Pick<ProjectSettings, "githubCloseSourceIssueOnDone" | "githubAuthMode" | "githubAuthToken">;
    if (settings.githubCloseSourceIssueOnDone !== true) {
      return;
    }

    const action = decideIssueAction(event.from, event.to);
    if (!action) {
      return;
    }
    const state = action.action === "close" ? "closed" : "open";

    const sourceIssue = event.task.sourceIssue;
    if (!sourceIssue || sourceIssue.provider !== "github") {
      return;
    }

    const repository = sourceIssue.repository ?? "";
    const [owner, repo] = repository.split("/");
    const issueNumber = sourceIssue.issueNumber;
    if (!owner || !repo || !Number.isInteger(issueNumber)) {
      await safeLogTaskEntry(
        store,
        event.task.id,
        "Failed to close linked GitHub source issue",
        `Invalid GitHub source issue metadata: ${repository}#${String(issueNumber)}`,
        { logger: terminalTaskWriteLog, context: "github-source-issue-close" },
      );
      return;
    }

    const issueNumberValue = issueNumber as number;

    try {
      const globalSettings = (await store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
      const resolution = resolveGithubTrackingAuth({ projectSettings: settings, globalSettings });
      if (!resolution.ok) {
        await safeLogTaskEntry(store, event.task.id, "Skipped closing GitHub source issue", resolution.message, { logger: terminalTaskWriteLog, context: "github-source-issue-close" });
        return;
      }

      const client = resolution.auth.mode === "token"
        ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
        : new GitHubClient({ forceMode: "gh-cli" });

      const existing = await client.getIssue(owner, repo, issueNumberValue);
      if (!existing || existing.state === state) {
        await safeLogTaskEntry(
          store,
          event.task.id,
          `Skipped ${action.action === "close" ? "closing" : "reopening"} GitHub source issue - issue not found or already ${state}`,
          `${owner}/${repo}#${issueNumberValue}`,
          { logger: terminalTaskWriteLog, context: "github-source-issue-close" },
        );
        return;
      }

      const applyIssueAction = async () => {
        await client.setIssueState(owner, repo, issueNumberValue, state, action.stateReason);
      };

      try {
        await applyIssueAction();
      } catch (error) {
        if (!isTransientGitHubError(error)) {
          throw error;
        }
        await delay(25);
        await applyIssueAction();
      }

      await safeLogTaskEntry(
        store,
        event.task.id,
        `${action.action === "close" ? "Closed" : "Reopened"} linked GitHub source issue`,
        `${owner}/${repo}#${issueNumberValue}`,
        { logger: terminalTaskWriteLog, context: "github-source-issue-close" },
      );
    } catch (error) {
      await safeLogTaskEntry(
        store,
        event.task.id,
        "Failed to close linked GitHub source issue",
        error instanceof Error ? error.message : String(error),
        { logger: terminalTaskWriteLog, context: "github-source-issue-close" },
      );
    }
  }
}
