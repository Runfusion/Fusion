import { createLogger, type GithubIssueAction, type Task, type TaskDeleteClosureContext, type TaskStore } from "@fusion/core";

const gitLabDeleteCloseLog = createLogger("dashboard-gitlab-delete-close");
import { formatGitLabTargetLabel, resolveGitLabTarget, safeLogGitLabEntry, type GitLabLifecycleTarget } from "./gitlab-lifecycle.js";
import { updateGitLabTargetState } from "./gitlab-tracking-state.js";

type TaskDeletedMeta = {
  githubIssueAction?: GithubIssueAction;
  closureContext?: TaskDeleteClosureContext | { kind?: string };
  observed?: boolean;
};

export type GitLabDeleteAction =
  | { action: "close"; target: GitLabLifecycleTarget; deletionUnsupported: boolean }
  | { action: "skip"; reason: "split-close" | "leave" | "merge-request" | "no-target" };

/** Decides delete behavior after the delete-only ownership resolver has selected one target. */
export function decideGitLabDeleteAction(
  meta: TaskDeletedMeta | undefined,
  target: GitLabLifecycleTarget | null,
): GitLabDeleteAction {
  if (meta?.closureContext?.kind === "split-into-subtasks") return { action: "skip", reason: "split-close" };
  if (!target) return { action: "skip", reason: "no-target" };
  if (meta?.githubIssueAction === "leave") return { action: "skip", reason: "leave" };
  if (target.kind === "merge_request") return { action: "skip", reason: "merge-request" };
  return { action: "close", target, deletionUnsupported: meta?.githubIssueAction === "delete" };
}

/*
FNXC:GitLabCloseOnDelete 2026-08-01-17:10:
An ordinary delete closes a linked GitLab issue by default but never an MR: deleting a local task is
not authority to abandon someone else's review. GitLab has no safe issue-delete client operation, so
an explicit delete request degrades to close. This is independent of gitlabCloseSourceIssueOnDone,
which governs task:moved only; this listener alone opts into malformed-tracking source fallback.

The outer boundary must swallow every rejection because EventEmitter does not own async listener
failures. Shared update/log helpers retain retry and deleted-row handling; any other failure emits one
structured warning with only task ID, lifecycle stage, and normalized error information rather than an
unhandled rejection or a second close attempt.
*/
export class GitLabDeleteCloseService {
  private readonly defaultStore: TaskStore;
  private readonly listeners = new Map<TaskStore, { onTaskDeleted: (task: Task, meta?: TaskDeletedMeta) => void }>();
  private started = false;

  constructor(store: TaskStore) { this.defaultStore = store; }

  start(): void { if (this.started) return; this.started = true; this.attach(this.defaultStore); }
  stop(): void { if (!this.started) return; this.started = false; for (const store of [...this.listeners.keys()]) this.detach(store); }

  attach(store: TaskStore): void {
    if (this.listeners.has(store)) return;
    const onTaskDeleted = (task: Task, meta?: TaskDeletedMeta): void => { void this.handleTaskDeleted(store, task, meta); };
    this.listeners.set(store, { onTaskDeleted });
    if (this.started) store.on("task:deleted", onTaskDeleted);
  }

  detach(store: TaskStore): void {
    const handlers = this.listeners.get(store);
    if (!handlers) return;
    store.off("task:deleted", handlers.onTaskDeleted);
    this.listeners.delete(store);
  }

  private async handleTaskDeleted(store: TaskStore, task: Task, meta?: TaskDeletedMeta): Promise<void> {
    /* FNXC:CrossProcessDeleteObservation 2026-08-01-13:03: Observed outbox replays never repeat GitLab close/delete-side effects. */
    if (meta?.observed) return;
    let stage = "resolve";
    try {
      const target = resolveGitLabTarget(task, { fallbackToSourceOnInvalidTracking: true });
      const decision = decideGitLabDeleteAction(meta, target);
      if (decision.action === "skip") {
        stage = "log-skip";
        if (decision.reason === "split-close") return;
        const details = target ? formatGitLabTargetLabel(target.kind, target.project, target.iid) : "No linked GitLab issue";
        const message = decision.reason === "leave"
          ? "Left linked GitLab issue unchanged on task delete"
          : decision.reason === "merge-request"
            ? "Skipped GitLab merge request on task delete"
            : "Skipped GitLab close on task delete";
        await safeLogGitLabEntry(store, task.id, message, details);
        return;
      }

      if (decision.deletionUnsupported) {
        stage = "log-delete-unsupported";
        await safeLogGitLabEntry(store, task.id, "GitLab issue deletion is not supported; closed instead", decision.target.label);
      }
      stage = "close";
      await updateGitLabTargetState(store, task.id, decision.target, "closed", "source");
    } catch (error) {
      gitLabDeleteCloseLog.warn("[gitlab-delete-close] listener failure", {
        taskId: task.id,
        stage,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
