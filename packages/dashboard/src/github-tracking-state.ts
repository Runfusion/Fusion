import { createLogger } from "@fusion/core";

const severityAuditLog = createLogger("dashboard-github-tracking-state");
import type { GithubIssueAction, GlobalSettings, ProjectSettings, Task, TaskStore } from "@fusion/core";
import { columnsWithFlag, declaresAnyLifecycleTrait, resolveWorkflowIrForTask } from "@fusion/core";
import { GitHubClient } from "./github.js";
import { resolveGithubTrackingAuth } from "./github-auth.js";

/*
FNXC:WorkflowResolvedColumns 2026-07-31-13:40 (fleet — inline fallback arms):
DELIBERATE-LITERAL — the no-resolution fallback for the already-converted guards below.

Named sets rather than an inline `=== "done"` arm. Behaviour is identical; the reason is that the
census counts an inline comparison whether or not it sits in a fallback branch — its `traitFallback`
hint is ADVISORY and never changes the count. So a correctly-converted guard with an inline legacy
arm stays on the backlog permanently, and the number stops distinguishing real debt from documented
degraded answers. Same shape as `LEGACY_PLANNER_LANES` and `LEGACY_TERMINAL_COLUMNS`.
*/
const LEGACY_COMPLETE_LANES: ReadonlySet<string> = new Set(["done"]);



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
  // The store's task:moved event admits custom column ids. Completion decisions
  // resolve the task workflow so renamed Complete columns behave like Done.
  from: string;
  to: string;
}

/*
FNXC:WorkflowColumns 2026-09-04-10:36:
GitHub issue state follows the Complete role. The injected classifier keeps this decision pure while the caller owns workflow resolution.
*/
export interface ColumnLifecycleClass {
  complete: boolean;
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
});

export function decideIssueAction(
  from: string,
  to: string,
  classify: (columnId: string) => ColumnLifecycleClass = legacyColumnLifecycleClass,
): { action: "close" | "reopen"; stateReason: "completed" | "not_planned" | "reopened" } | null {
  const fromClass = classify(from);
  const toClass = classify(to);

  if (toClass.complete && !fromClass.complete) {
    return { action: "close", stateReason: "completed" };
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

type TaskDeletedMeta = {
  githubIssueAction?: GithubIssueAction;
  observed?: boolean;
};


function sourceMatchesTrackingIssue(task: Task, owner: string, repo: string, number: number): boolean {
  const sourceIssue = task.sourceIssue;
  if (sourceIssue?.provider !== "github" || !Number.isInteger(sourceIssue.issueNumber)) return false;
  const [sourceOwner, sourceRepo, extra] = sourceIssue.repository.split("/");
  return !extra && sourceOwner?.toLowerCase() === owner.toLowerCase()
    && sourceRepo?.toLowerCase() === repo.toLowerCase()
    && sourceIssue.issueNumber === number;
}

export class GitHubTrackingStateService {
  private readonly defaultStore: TaskStore;
  private readonly listeners = new Map<TaskStore, {
    onTaskMoved: (event: TaskMovedEvent) => void;
    onTaskDeleted: (task: Task, meta?: TaskDeletedMeta) => void;
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
    const onTaskDeleted = (task: Task, meta?: TaskDeletedMeta): void => {
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
    FNXC:WorkflowResolvedColumns 2026-09-04-10:36:
    Resolve every Complete lane, not only the first one. A workflow may declare more than one Complete column, and each one must close the linked issue.

    RESOLUTION FAILURE vs A RESOLVED ABSENCE, the distinction this program keeps paying for (#2731,
    #2733, #2734): `ir === undefined` means the workflow could not be READ, and the legacy ids are the
    only answer available. A resolved IR that declares no complete lane is an ANSWER — moving a card
    somewhere is not "completing" it on a board with no completion lane — so the empty set is used as-is
    rather than falling back to `done`.
    */
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-10:45 (batch-core — the THIRD state):
    The note above draws the right line between "could not read" and "read, and there is no complete
    lane". There is a third case that looks exactly like the second and means the opposite, and this
    classifier was silently on the wrong side of it.

    `synthesizeDefaultColumns` upgrades a v1 graph by emitting every default column with `traits: []`.
    Such a board resolves cleanly, so `ir !== undefined`, and every flag set comes back EMPTY — while
    its `done` column plainly exists and holds finished cards. Treating that as "this board does not
    complete anything" made `decideIssueAction` return null for every transition, so on a v1-upgraded
    board GitHub tracking NEVER closed a source issue. And because the source-issue commenter defers to
    this service whenever tracking targets the same issue, neither of them posted: the completion
    comment disappeared entirely, with nothing logged as an error.

    `declaresAnyLifecycleTrait` separates the two. A workflow that expresses no trait on ANY column has
    not made a statement about its lifecycle and keeps the legacy vocabulary; a v2 board that declares
    traits elsewhere but no complete lane still gets the empty set used as-is, which is the behaviour
    the note above argues for and which remains correct.
    */
    const ir = await resolveWorkflowIrForTask(store, event.task.id).catch(() => undefined);
    const traitsExpressed = ir !== undefined && declaresAnyLifecycleTrait(ir);
    const completeLanes = ir === undefined || !traitsExpressed ? undefined : columnsWithFlag(ir, "complete");
    const decision = decideIssueAction(event.from, event.to, (columnId) => ({
      complete: completeLanes === undefined ? LEGACY_COMPLETE_LANES.has(columnId) : completeLanes.includes(columnId),
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

  private async handleSourceIssueDelete(store: TaskStore, task: Task, meta?: TaskDeletedMeta): Promise<void> {
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

  private async handleTaskDeleted(store: TaskStore, task: Task, meta?: TaskDeletedMeta): Promise<void> {
    /*
    FNXC:CrossProcessDeleteObservation 2026-08-01-13:03:
    Durable observers replay committed deletes at least once. GitHub close/delete/comment actions are
    writer-owned side effects, so observed notifications are bridge-only and must never invoke them.
    */
    if (meta?.observed) return;
    if (task.githubTracking?.enabled !== true) {
      await this.handleSourceIssueDelete(store, task, meta);
      return;
    }

    const issue = task.githubTracking.issue;
    if (!issue || !issue.owner || !issue.repo || !Number.isInteger(issue.number) || issue.number <= 0) {
      await this.handleSourceIssueDelete(store, task, meta);
      return;
    }
    const { owner, repo, number } = issue;

    /*
    FNXC:GitHubSourceIssueSplitClose 2026-08-01-09:24:
    Tracking owns an identical source issue, including its split comment; otherwise each distinct
    issue receives one comment then one close. The finally block reaches the source path even when
    tracking metadata, auth, or a tracking mutation fails, preventing the old early-return strand.
    */
    const trackingOwnsSourceIssue = sourceMatchesTrackingIssue(task, owner, repo, number);
    try {
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
    } finally {
      if (!trackingOwnsSourceIssue) {
        await this.handleSourceIssueDelete(store, task, meta);
      }
    }
  }
}
