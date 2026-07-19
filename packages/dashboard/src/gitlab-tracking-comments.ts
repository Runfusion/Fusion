import type { Task, TaskStore } from "@fusion/core";
import { resolveGitLabClient, resolveGitLabTargetFromItem, safeLogGitLabEntry } from "./gitlab-lifecycle.js";
import { getCliPackageVersion } from "./cli-package-version.js";
import { formatReleaseVersionLines } from "./fusion-release-version.js";

const COMMENT_MAX_LENGTH = 500;
const DONE_COMMENT_MAX_LENGTH = 2000;

interface TaskMovedEvent { task: Task; from: string; to: string; }

function clean(value: string): string { return value.replace(/\s+/g, " ").replace(/[[\]()]/g, "").trim(); }
function truncate(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`; }
function title(task: Pick<Task, "title" | "description">, max: number): string {
  const value = clean(task.title ?? "") || clean((task.description ?? "").split("\n", 1)[0] ?? "") || "Untitled task";
  return truncate(value, max);
}

/*
 * FNXC:GitLabTrackingComments 2026-07-15-10:05:
 * Requirement (issue #1916 follow-up): GitLab done comments carry the same Fusion self-repo release
 * lines as the GitHub surface, via the shared fusion-release-version helper. `repository` must be the
 * project PATH — resolveGitLabTargetFromItem() prefers the numeric projectId, which never matches the
 * self-repo slug — so callers pass item.projectPath explicitly rather than the resolved target.project.
 * Release lines join `lines` so they count against DONE_COMMENT_MAX_LENGTH and shrink the title budget.
 */
export function formatGitLabTrackingComment(
  task: Pick<Task, "id" | "title" | "description" | "branch" | "mergeDetails">,
  transition: "in-progress" | "done",
  targetUrl?: string,
  options?: { repository?: string; currentVersion?: string | (() => string) },
): string {
  if (transition === "in-progress") {
    const prefix = `Fusion task: ${task.id}\n\n`;
    const stem = "🚧 In progress — work has started on “";
    const suffix = "”.";
    return `${prefix}${stem}${title(task, COMMENT_MAX_LENGTH - prefix.length - stem.length - suffix.length)}${suffix}`;
  }
  const lines: string[] = [];
  if (task.mergeDetails?.commitSha) lines.push(`Commit: ${task.mergeDetails.commitSha.slice(0, 7)}`);
  if (task.branch) lines.push(`Branch: ${clean(task.branch)}`);
  if (task.mergeDetails?.mergedAt) lines.push(`Merged: ${task.mergeDetails.mergedAt}`);
  if (targetUrl) lines.push(`GitLab: ${targetUrl}`);
  if (options?.repository) {
    lines.push(...formatReleaseVersionLines(
      options.repository,
      options.currentVersion ?? (() => getCliPackageVersion()),
    ));
  }
  const prefix = `Fusion task: ${task.id}\n\n`;
  const stem = "✅ Done — “";
  const suffix = "” is complete.";
  const extra = lines.length ? `\n${lines.join("\n")}` : "";
  return `${prefix}${stem}${title(task, DONE_COMMENT_MAX_LENGTH - prefix.length - stem.length - suffix.length - extra.length)}${suffix}${extra}`;
}

export class GitLabTrackingCommentService {
  private readonly store: TaskStore;
  private readonly onTaskMoved = (event: TaskMovedEvent): void => { void this.handleTaskMoved(event); };
  private started = false;

  constructor(store: TaskStore) { this.store = store; }

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
    if (event.from === event.to || (event.to !== "in-progress" && event.to !== "done")) return;
    const item = event.task.gitlabTracking?.item;
    if (!item) return;
    const target = resolveGitLabTargetFromItem(item);
    if (!target) {
      await safeLogGitLabEntry(this.store, event.task.id, "Failed to post GitLab tracking comment", "Linked GitLab metadata is incomplete");
      return;
    }
    const body = formatGitLabTrackingComment(
      event.task,
      event.to,
      event.to === "done" ? target.url : undefined,
      { repository: item.projectPath },
    );
    try {
      const resolved = await resolveGitLabClient(this.store);
      if (!resolved.ok) {
        await safeLogGitLabEntry(this.store, event.task.id, "Skipped GitLab tracking comment", resolved.message);
        return;
      }
      if (target.kind === "merge_request") await resolved.client.commentOnMergeRequest(target.project, target.iid, body);
      else await resolved.client.commentOnProjectIssue(target.project, target.iid, body);
      await safeLogGitLabEntry(this.store, event.task.id, "Posted GitLab tracking comment", `${target.label} (${event.to})`);
    } catch (error) {
      await safeLogGitLabEntry(this.store, event.task.id, "Failed to post GitLab tracking comment", error instanceof Error ? error.message : String(error));
    }
  }
}
