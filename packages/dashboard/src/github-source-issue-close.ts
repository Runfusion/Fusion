/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2 Stage D — why every mutation context in this file is the MARKER):

This module runs UNATTENDED: a poll/reconcile sweep or a lifecycle hook reacting to an external event,
not a request anyone made. There is no session, no run and no acting agent to derive from, and the only
ids in scope name the task being reconciled — attributing to those would produce audit rows claiming a
task reconciled itself, the same false attribution the engine's self-healing sweeps refused in Stage A.

So each write carries the unattributed marker, counted by the U18 census and ratcheted DOWN.
Whether these lanes get a real SYSTEM actor is U13's decision; it is deliberately not made here.
*/
// FNXC:Identity 2026-08-09-03:04: one-line import on purpose — the U18 census counts any non-`import`-prefixed line naming the marker, so a multi-line import block would score as debt it is not.
import { UNATTRIBUTED_MUTATION_CONTEXT } from "@fusion/core";
import type { GlobalSettings, ProjectSettings, TaskStore } from "@fusion/core";
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
      void this.handleTaskMoved(store, event);
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
      await store.logEntry(
        event.task.id,
        "Failed to close linked GitHub source issue",
        `Invalid GitHub source issue metadata: ${repository}#${String(issueNumber)}`,
        UNATTRIBUTED_MUTATION_CONTEXT,
      );
      return;
    }

    const issueNumberValue = issueNumber as number;

    try {
      const globalSettings = (await store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
      const resolution = resolveGithubTrackingAuth({ projectSettings: settings, globalSettings });
      if (!resolution.ok) {
        await store.logEntry(event.task.id, "Skipped closing GitHub source issue", resolution.message, UNATTRIBUTED_MUTATION_CONTEXT);
        return;
      }

      const client = resolution.auth.mode === "token"
        ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
        : new GitHubClient({ forceMode: "gh-cli" });

      const existing = await client.getIssue(owner, repo, issueNumberValue);
      if (!existing || existing.state === state) {
        await store.logEntry(
          event.task.id,
          `Skipped ${action.action === "close" ? "closing" : "reopening"} GitHub source issue - issue not found or already ${state}`,
          `${owner}/${repo}#${issueNumberValue}`,
          UNATTRIBUTED_MUTATION_CONTEXT,
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

      await store.logEntry(
        event.task.id,
        `${action.action === "close" ? "Closed" : "Reopened"} linked GitHub source issue`,
        `${owner}/${repo}#${issueNumberValue}`,
        UNATTRIBUTED_MUTATION_CONTEXT,
      );
    } catch (error) {
      await store.logEntry(
        event.task.id,
        "Failed to close linked GitHub source issue",
        error instanceof Error ? error.message : String(error),
        UNATTRIBUTED_MUTATION_CONTEXT,
      );
    }
  }
}
