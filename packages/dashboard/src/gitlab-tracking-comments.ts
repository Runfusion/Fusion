import type { Task, TaskStore } from "@fusion/core";
import { resolveTaskLifecycleColumns } from "@fusion/core";
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
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-09:10 (fleet phase — FLAGGED AND LEFT COUNTED, same as its GitHub twin):
  A pure formatter. `transition` is this function's OWN `"in-progress" | "done"` parameter — a discriminant
  the caller chose, not a column id read off a task — and there is no store or task id in scope to resolve
  from. `github-tracking-comments.ts:165` is the same site with the same decision, so both halves of the
  pair now leave exactly one literal, in the same place, for the same reason.
  */
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-06:10 DELIBERATE-LITERAL: a transition KIND, not a board column.

  `transition` is the closed union `"in-progress" | "done"` declared in this function's own signature.
  It names WHICH COMMENT TEMPLATE to render; the caller decides that from the task's resolved lanes and
  passes the kind down. Resolving it against a workflow would be a category error — there is no task
  column in scope here at all.

  The census matches on the spelling, so this reads as an unconverted lifecycle guard. It is the same
  bare-variable false-positive class as the reports plugin's `ReportStatus`: the AST cannot tell a
  foreign enum from a column id because the receiver name carries no type. Marked rather than left
  counted, so it is not re-dispatched for conversion indefinitely.
  */
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
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-09:10 (fleet phase — the GitLab half of the pair):
    IDENTICAL shape and ordering to `github-tracking-comments.ts`'s `handleTaskMoved`, on purpose. That
    file's note explains the reordering: the lane test needs a resolved workflow, and resolving on EVERY
    move to discover that most moves are not notable is the cost worth avoiding — so the cheap tracked-item
    read (a plain property read on the event's own task) runs FIRST and short-circuits every untracked
    move. Only tracked tasks resolve a workflow, and those are the ones that need the answer.

    This file is why the pair matters. GitHub tracking was being converted while GitLab tracking kept the
    literals, which is the FN-6115 -> FN-6118 -> FN-6123 shape: one behaviour living in two modules with
    only one converted. The two now read the same, so a reviewer can diff them.
    */
    if (event.from === event.to) return;
    const item = event.task.gitlabTracking?.item;
    if (!item) return;

    const movedLifecycle = await resolveTaskLifecycleColumns(this.store, event.task.id);
    const wipColumn = movedLifecycle?.wip ?? "in-progress";
    const completeColumn = movedLifecycle?.complete ?? "done";

    if (event.to !== wipColumn && event.to !== completeColumn) return;
    const target = resolveGitLabTargetFromItem(item);
    if (!target) {
      await safeLogGitLabEntry(this.store, event.task.id, "Failed to post GitLab tracking comment", "Linked GitLab metadata is incomplete");
      return;
    }
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-09:20 (fleet phase — a narrowing the old literal was doing for free):
    `transition` is derived EXPLICITLY rather than passed as `event.to`. The removed early return
    (`event.to !== "in-progress" && event.to !== "done"`) was not only a guard — it also NARROWED
    `event.to` to the formatter's `"in-progress" | "done"` parameter type. Comparing against resolved
    lane variables cannot narrow a string, so tsc rejected the call, which is the compiler catching the
    real consequence: on a renamed board `event.to` was never one of those two words anyway, so passing
    it through was always the wrong value for a parameter that means "which comment shape".

    Naming the discriminant separates the two questions the literal was conflating — WHICH LANE did the
    card enter (a role question, resolved) and WHICH COMMENT does that warrant (a formatter mode, fixed).

    A BOOLEAN, not a `"done" | "in-progress"` string. My first version named it as a string and then asked
    `transition === "done"` further down, which the census correctly counted as a NEW column guard (its
    receiver is a local, but the classifier cannot know that, and it is the same shape as the
    `mode === "done"` pair in useTaskDiffStats). A boolean answers the same question without introducing a
    literal comparison at all — better than adding a site and then exempting it with a marker.
    */
    const isCompleteTransition = event.to === completeColumn;
    const body = formatGitLabTrackingComment(
      event.task,
      isCompleteTransition ? "done" : "in-progress",
      isCompleteTransition ? target.url : undefined,
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
