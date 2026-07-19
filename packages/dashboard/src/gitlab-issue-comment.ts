import type { ProjectSettings, Task, TaskStore } from "@fusion/core";
import { resolveGitLabClient, resolveGitLabTarget, resolveGitLabTargetFromItem, safeLogGitLabEntry } from "./gitlab-lifecycle.js";
import { getCliPackageVersion } from "./cli-package-version.js";
import { formatReleaseVersionLines } from "./fusion-release-version.js";

interface TaskMovedEvent {
  task: Task;
  /** Present on the real store event; GitLabTrackingCommentService no-ops when `from === to`. */
  from?: string;
  to: string;
}

/*
 * FNXC:GitLabIssueComment 2026-07-15-11:20:
 * Requirement: a task must never receive TWO done comments on the SAME GitLab item. GitLab imports
 * always carry BOTH linkages — buildGitLabTaskProvenance() returns sourceIssue AND gitlabTracking.item
 * for the same item — so with `gitlabCommentOnDone` on, EVERY imported task was double-commented
 * (broader than the GitHub case, where adoption is conditional).
 *
 * Identity here is by construction, not by comparison: resolveGitLabTarget() prefers
 * gitlabTracking.item over sourceIssue, so whenever the item resolves, THIS service's target IS the
 * tracking service's target. Suppress this service then and let the tracking service post the richer
 * comment. With no item, resolveGitLabTarget() falls back to sourceIssue and this service still posts
 * — the imported-with-tracking-off case.
 *
 * Mirrors the tracking service's `from === to` no-op guard: on a same-column re-emit it stays silent,
 * so suppressing here would drop the only comment.
 */
function trackingCommentCoversTarget(event: TaskMovedEvent): boolean {
  if (event.from === event.to) {
    return false;
  }
  const item = event.task.gitlabTracking?.item;
  return Boolean(item && resolveGitLabTargetFromItem(item));
}

export const DEFAULT_GITLAB_COMMENT_TEMPLATE = "✅ Task {taskId} ({taskTitle}) has been completed and resolved.";

/*
 * FNXC:GitLabIssueComment 2026-07-15-10:40:
 * Mirrors the GitHub self-repo release lines (issue #1916) via the shared fusion-release-version
 * helper, so the two cannot drift the way github-issue-comment.ts drifted from
 * github-tracking-comments.ts.
 *
 * NOT redundant with GitLabTrackingCommentService: this service covers the `sourceIssue` IMPORT
 * linkage (documented `gitlabCommentOnDone`; docs/settings-reference.md), while that one covers the
 * `gitlabTracking.item` linkage. An issue imported with tracking off has sourceIssue and no
 * tracking, so THIS is the only surface that comments. Do not delete it as a duplicate.
 */
export class GitLabIssueCommentService {
  private readonly store: TaskStore;
  private readonly getCurrentVersion: () => string;
  private readonly onTaskMoved = (event: TaskMovedEvent): void => { void this.handleTaskMoved(event); };
  private started = false;

  constructor(store: TaskStore, getCurrentVersion?: () => string) {
    this.store = store;
    this.getCurrentVersion = getCurrentVersion ?? (() => getCliPackageVersion());
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
    if (event.to !== "done" || event.task.sourceIssue?.provider !== "gitlab") return;
    const settings = await this.store.getSettings() as Pick<ProjectSettings, "gitlabCommentOnDone" | "gitlabCommentTemplate">;
    if (settings.gitlabCommentOnDone !== true) return;

    const target = resolveGitLabTarget(event.task);
    if (!target) {
      await safeLogGitLabEntry(this.store, event.task.id, "Skipped GitLab source comment", "Linked GitLab source metadata is incomplete");
      return;
    }

    if (trackingCommentCoversTarget(event)) {
      await safeLogGitLabEntry(this.store, event.task.id, "Skipped GitLab source comment", `${target.label} is tracked; GitLab tracking comment covers it`);
      return;
    }

    const template = settings.gitlabCommentTemplate || DEFAULT_GITLAB_COMMENT_TEMPLATE;
    let body = template.replaceAll("{taskId}", event.task.id).replaceAll("{taskTitle}", event.task.title ?? "");

    // Project PATH only — resolveGitLabTarget() prefers the numeric projectId, which never matches the slug.
    const repository = event.task.gitlabTracking?.item?.projectPath ?? event.task.sourceIssue?.repository;
    if (repository) {
      const versionLines = formatReleaseVersionLines(repository, () => this.getCurrentVersion());
      if (versionLines.length > 0) {
        body += `\n\n${versionLines.join("\n")}`;
      }
    }

    try {
      const resolved = await resolveGitLabClient(this.store);
      if (!resolved.ok) {
        await safeLogGitLabEntry(this.store, event.task.id, "Skipped GitLab source comment", resolved.message);
        return;
      }
      if (target.kind === "merge_request") {
        await resolved.client.commentOnMergeRequest(target.project, target.iid, body);
      } else {
        await resolved.client.commentOnProjectIssue(target.project, target.iid, body);
      }
      await safeLogGitLabEntry(this.store, event.task.id, "Posted GitLab issue completion comment", target.label);
    } catch (error) {
      await safeLogGitLabEntry(this.store, event.task.id, "Failed to post GitLab issue comment", error instanceof Error ? error.message : String(error));
    }
  }
}
