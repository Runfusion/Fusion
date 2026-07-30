import { createLogger } from "@fusion/core";

const severityAuditLog = createLogger("dashboard-github-tracking-state");
import type { GithubIssueAction, GlobalSettings, ProjectSettings, Task, TaskStore } from "@fusion/core";
import { columnsWithFlag, resolveWorkflowIrForTask } from "@fusion/core";
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

/*
FNXC:WorkflowResolvedColumns 2026-07-31-10:15 DELIBERATE-LITERAL:
The named legacy default of the injected-classifier seam, and the only place these two ids remain in this
file. It is the answer when no workflow can be resolved — the documented degraded mode — not an
unconverted guard: `decideIssueAction`'s `classify` parameter defaults to it so a caller without an IR
keeps today's mapping exactly.

Marked deliberate only now that the production caller actually passes a RESOLVED classifier. Before that
this default was the live path on every move, and exempting it would have hidden the real defect behind a
marker — which is why the wiring change and this marker are in the same commit.
*/
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
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-10:15 (fleet phase — THE SEAM WAS NEVER WIRED):
    `decideIssueAction` has taken an injectable `classify` since U12/R2, and the header above states the
    defect it fixed: "a user-authored workflow whose terminal column is called something else never closed
    its linked GitHub issue". But this — the ONLY production caller — passed no classifier, so every real
    move fell through to `legacyColumnLifecycleClass` and the described bug was still live. The seam was
    reachable from tests only.

    That is the same shape as this branch's earlier finding on the tracking-comment guard: a conversion
    that reads as done, with the resolved path unreachable in production. The lesson is that adding the
    seam and wiring it are two changes, and only the second one fixes anything.

    ORDER MATTERS, and it is inverted from the original. `decideIssueAction` ran FIRST here, before the
    tracking-enabled check, because comparing two strings is free. Resolving a workflow is not, so the
    cheap property read now short-circuits first and only tracked tasks resolve — the same ordering
    `github-tracking-comments.ts` and its GitLab twin settled on. Behaviour is unchanged for untracked
    tasks: they returned without acting before and still do.
    */
    if (event.task.githubTracking?.enabled !== true) {
      return;
    }

    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-14:20 (PR #2754 review — greptile):
    EVERY TERMINAL LANE, NOT THE FIRST ONE. `LifecycleColumns` names one column per role by design
    (#2721 pinned that), so a workflow declaring `complete` or `archived` on two columns had the second
    invisible here: moving a card there left the linked GitHub issue OPEN, and moving it back out never
    reopened one.

    Core's `resolveTerminalColumns` does not help — it is the same singular pair, one `complete` and one
    `archived`. The flag sets are the membership answer.

    RESOLUTION FAILURE vs A RESOLVED ABSENCE, the distinction this program keeps paying for (#2731,
    #2733, #2734): `ir === undefined` means the workflow could not be READ, and the legacy ids are the
    only answer available. A resolved IR that declares no complete lane is an ANSWER — moving a card
    somewhere is not "completing" it on a board with no completion lane — so the empty set is used as-is
    rather than falling back to `done`.
    */
    const ir = await resolveWorkflowIrForTask(store, event.task.id).catch(() => undefined);
    const completeLanes = ir === undefined ? undefined : columnsWithFlag(ir, "complete");
    const archivedLanes = ir === undefined ? undefined : columnsWithFlag(ir, "archived");
    const decision = decideIssueAction(event.from, event.to, (columnId) => ({
      complete: completeLanes === undefined ? columnId === "done" : completeLanes.includes(columnId),
      archived: archivedLanes === undefined ? columnId === "archived" : archivedLanes.includes(columnId),
    }));
    if (!decision) {
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
        severityAuditLog.warn(`[github-tracking-state] Unable to write log entry for deleted task ${taskId}: ${message}`);
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
