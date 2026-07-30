import { createLogger, resolveTaskLifecycleColumns } from "@fusion/core";

const severityAuditLog = createLogger("dashboard-github-tracking-comments");
import type { GlobalSettings, MergeDetails, ProjectSettings, Task, TaskStore } from "@fusion/core";
import { deriveTitleFromDescription } from "./github-tracking.js";
import { GitHubClient } from "./github.js";
import { resolveGithubTrackingAuth } from "./github-auth.js";
import { getCliPackageVersion } from "./cli-package-version.js";
import { formatReleaseVersionLines } from "./fusion-release-version.js";

const COMMENT_MAX_LENGTH = 500;
const DONE_COMMENT_MAX_LENGTH = 2000;

interface TaskMovedEvent {
  task: Task;
  from: string;
  to: string;
}

interface TrackingLinkContext {
  owner: string;
  repo: string;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeInlineText(value: string): string {
  return collapseWhitespace(value).replace(/[[\]()]/g, "").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }

  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength === 1) {
    return "…";
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatTitleSegment(title: string, maxLength: number): string {
  return truncateText(title, maxLength);
}

function resolveTrackingTitle(
  task: Pick<Task, "title" | "description">,
  maxLength: number,
): string {
  return sanitizeInlineText(task.title ?? "")
    || deriveTitleFromDescription(task.description, maxLength)
    || "Untitled task";
}

function formatCommitLine(
  mergeDetails: MergeDetails | undefined,
  linkContext: TrackingLinkContext | undefined,
  includeSubject: boolean,
): string | null {
  const commitSha = collapseWhitespace(mergeDetails?.commitSha ?? "");
  if (!commitSha) {
    return null;
  }

  const shortSha = commitSha.slice(0, 7);
  const subject = includeSubject
    ? sanitizeInlineText((mergeDetails?.mergeCommitMessage ?? "").split("\n", 1)[0] ?? "")
    : "";
  const label = subject ? `${shortSha} ${subject}` : shortSha;

  if (!linkContext) {
    return `Commit: ${label}`;
  }

  const url = `https://github.com/${linkContext.owner}/${linkContext.repo}/commit/${commitSha}`;
  return `Commit: [${label}](${url})`;
}

function formatFilesLine(mergeDetails: MergeDetails | undefined): string | null {
  if (typeof mergeDetails?.filesChanged !== "number") {
    return null;
  }

  let line = `Files: ${mergeDetails.filesChanged} changed`;
  if (typeof mergeDetails.insertions === "number" || typeof mergeDetails.deletions === "number") {
    const insertions = typeof mergeDetails.insertions === "number" ? `+${mergeDetails.insertions}` : "+0";
    const deletions = typeof mergeDetails.deletions === "number" ? `-${mergeDetails.deletions}` : "-0";
    line += ` (${insertions} / ${deletions})`;
  }
  return line;
}

/*
 * FNXC:GitHubTrackingComments 2026-07-15-09:40:
 * Release lines join `optionalLines` (rather than being appended to the finished string) so they
 * are counted in `extraLength` and the title budget shrinks to accommodate them. Appending after
 * the fact would silently push long-title comments past DONE_COMMENT_MAX_LENGTH.
 */
function buildDoneComment(
  task: Pick<Task, "id" | "title" | "description" | "branch" | "mergeDetails">,
  linkContext?: TrackingLinkContext,
  options?: { includeCommitSubject?: boolean; includeFilesLine?: boolean; currentVersion?: string | (() => string) },
): string {
  const branch = sanitizeInlineText(task.branch ?? "");
  const mergedAt = collapseWhitespace(task.mergeDetails?.mergedAt ?? "");
  const prNumber = task.mergeDetails?.prNumber;
  const includeCommitSubject = options?.includeCommitSubject ?? true;
  const includeFilesLine = options?.includeFilesLine ?? true;

  const optionalLines: string[] = [];
  const commitLine = formatCommitLine(task.mergeDetails, linkContext, includeCommitSubject);
  if (commitLine) {
    optionalLines.push(commitLine);
  }
  if (branch) {
    optionalLines.push(`Branch: ${branch}`);
  }
  if (typeof prNumber === "number") {
    optionalLines.push(linkContext
      ? `PR: [${linkContext.owner}/${linkContext.repo}#${prNumber}](https://github.com/${linkContext.owner}/${linkContext.repo}/pull/${prNumber})`
      : `PR: #${prNumber}`);
  }
  if (includeFilesLine) {
    const filesLine = formatFilesLine(task.mergeDetails);
    if (filesLine) {
      optionalLines.push(filesLine);
    }
  }
  if (mergedAt) {
    optionalLines.push(`Merged: ${mergedAt}`);
  }
  if (linkContext) {
    optionalLines.push(...formatReleaseVersionLines(
      `${linkContext.owner}/${linkContext.repo}`,
      options?.currentVersion ?? (() => getCliPackageVersion()),
    ));
  }

  const prefix = `Fusion task: ${task.id}\n\n`;
  const stem = "✅ Done — “";
  const suffix = "” is complete.";
  const extraLength = optionalLines.length === 0 ? 0 : `\n${optionalLines.join("\n")}`.length;
  const available = DONE_COMMENT_MAX_LENGTH - prefix.length - stem.length - suffix.length - extraLength;
  const title = formatTitleSegment(resolveTrackingTitle(task, available), available);
  const statusLine = `${stem}${title}${suffix}`;

  return optionalLines.length === 0
    ? `${prefix}${statusLine}`
    : `${prefix}${statusLine}\n${optionalLines.join("\n")}`;
}

export function formatTrackingComment(
  task: Pick<Task, "id" | "title" | "description" | "branch" | "mergeDetails">,
  transition: "in-progress" | "done",
  linkContext?: TrackingLinkContext,
  options?: { currentVersion?: string | (() => string) },
): string {
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
  if (transition === "done") {
    const currentVersion = options?.currentVersion;
    let comment = buildDoneComment(task, linkContext, { includeCommitSubject: true, includeFilesLine: true, currentVersion });
    if (comment.length <= DONE_COMMENT_MAX_LENGTH) {
      return comment;
    }

    comment = buildDoneComment(task, linkContext, { includeCommitSubject: false, includeFilesLine: true, currentVersion });
    if (comment.length <= DONE_COMMENT_MAX_LENGTH) {
      return comment;
    }

    return buildDoneComment(task, linkContext, { includeCommitSubject: false, includeFilesLine: false, currentVersion });
  }

  const prefix = `Fusion task: ${task.id}\n\n`;
  const stem = "🚧 In progress — work has started on “";
  const suffix = "”.";

  const available = COMMENT_MAX_LENGTH - prefix.length - stem.length - suffix.length;
  const title = formatTitleSegment(resolveTrackingTitle(task, available), available);

  return `${prefix}${stem}${title}${suffix}`;
}

export class GitHubTrackingCommentService {
  private readonly store: TaskStore;
  private readonly inProgressCommentClaims = new Set<string>();
  private readonly onTaskMoved = (event: TaskMovedEvent): void => {
    void this.handleTaskMoved(event);
  };
  private started = false;

  constructor(store: TaskStore) {
    this.store = store;
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

  private async safeLogDeletedTaskEntry(taskId: string, message: string, details: string): Promise<void> {
    try {
      await this.store.logEntry(taskId, message, details);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes(`Task ${taskId} not found`)) {
        severityAuditLog.warn(`[github-tracking-comments] Unable to write log entry for deleted task ${taskId}: ${message}`);
        return;
      }
      throw error;
    }
  }

  private async handleTaskMoved(event: TaskMovedEvent): Promise<void> {
    if (event.from === event.to) {
      return;
    }

    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-23:55 (fleet: github-tracking-comments.ts):
    Resolved ONCE here — after the tracking-enabled gate — so a move on an UNTRACKED task pays nothing.

    FNXC:WorkflowResolvedColumns 2026-07-30-00:40 (PR #2715 review — greptile):
    THE TRACKING GATE NOW RUNS FIRST, AND THE COLUMN TEST IS RESOLVED.

    An earlier version kept a literal `to !== "in-progress" && to !== "done"` early return ABOVE the
    tracking gate, on the reasoning that converting it would make every task move in the project
    resolve a workflow. That reasoning was sound about cost and wrong about correctness: on a renamed
    board the literal never matched, so the function returned before reaching any of the resolved
    code below and the tracking comment was silently skipped. A conversion that cannot be reached is
    not a conversion.

    Reordering satisfies both. The tracking-enabled check is a plain property read on the event's own
    task, so it costs nothing and still short-circuits every UNTRACKED move — which is the population
    the cost argument was actually about. Only tracked tasks resolve a workflow, and those are the
    ones that need the answer.
    */
    if (event.task.githubTracking?.enabled !== true) {
      return;
    }

    const movedLifecycle = await resolveTaskLifecycleColumns(this.store, event.task.id);
    const wipColumn = movedLifecycle?.wip ?? "in-progress";
    const completeColumn = movedLifecycle?.complete ?? "done";

    if (event.to !== wipColumn && event.to !== completeColumn) {
      return;
    }

    const issue = event.task.githubTracking?.issue;
    if (!issue) {
      return;
    }

    const { owner, repo, number } = issue;
    if (!owner || !repo || !number) {
      await this.safeLogDeletedTaskEntry(
        event.task.id,
        "Failed to post GitHub tracking comment",
        "Linked issue metadata is incomplete",
      );
      return;
    }

    if (event.to === wipColumn) {
      if (this.inProgressCommentClaims.has(event.task.id)) {
        return;
      }
      this.inProgressCommentClaims.add(event.task.id);
    }

    /*
     * FNXC:GitHubTrackingComments 2026-07-16-12:40:
     * A closed tracked issue must link its landing commit when one exists, and in-progress comments
     * must honor the durable one-per-task marker. Re-read the authoritative row before either
     * transition; fall back to the event snapshot when the read fails so the comment is not dropped.
     */
    const authoritativeTask = await this.store.getTask(event.task.id).catch(() => null);
    const taskForComment = authoritativeTask ?? event.task;
    if (
      event.to === wipColumn
      && (
        taskForComment.githubTracking?.inProgressCommentedAt
        || taskForComment.log?.some((entry) => (
          entry.action === "Posted GitHub tracking comment"
          && entry.outcome?.endsWith("(in-progress)")
        ))
      )
    ) {
      return;
    }
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-00:40 (PR #2715 review — greptile):
    `formatTrackingComment`'s second parameter is a TRANSITION KIND, not a column id — it chooses
    which comment to build. Passing `event.to` only type-checked because the literal early return had
    narrowed it to the two legacy ids, so the id and the kind coincided on the default board. They do
    not coincide on a renamed one, which is the conflation this whole conversion is about. The role is
    now passed explicitly.
    */
    const body = event.to === completeColumn
      ? formatTrackingComment(taskForComment, "done", { owner, repo })
      : formatTrackingComment(taskForComment, "in-progress");

    let commentPosted = false;
    try {
      const projectSettings = await this.store.getSettings() as Pick<ProjectSettings, "githubAuthMode" | "githubAuthToken">;
      const globalSettings = (await this.store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
      const resolution = resolveGithubTrackingAuth({ projectSettings, globalSettings });
      if (!resolution.ok) {
        if (event.to === wipColumn) {
          this.inProgressCommentClaims.delete(event.task.id);
        }
        await this.safeLogDeletedTaskEntry(event.task.id, "Skipped GitHub tracking comment", resolution.message);
        return;
      }

      const client = resolution.auth.mode === "token"
        ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
        : new GitHubClient({ forceMode: "gh-cli" });
      await client.commentOnIssue(owner, repo, number, body);
      commentPosted = true;
      if (event.to === wipColumn) {
        try {
          await this.store.updateTask(event.task.id, {
            githubTracking: { inProgressCommentedAt: new Date().toISOString() },
          });
        } catch (markerError) {
          await this.safeLogDeletedTaskEntry(
            event.task.id,
            "Posted GitHub tracking comment",
            `${owner}/${repo}#${number} (${event.to})`,
          );
          severityAuditLog.warn(
            `[github-tracking-comments] Posted in-progress comment for ${event.task.id}, but failed to persist its marker: ${markerError instanceof Error ? markerError.message : String(markerError)}`,
          );
          return;
        }
      }
      await this.safeLogDeletedTaskEntry(
        event.task.id,
        "Posted GitHub tracking comment",
        `${owner}/${repo}#${number} (${event.to})`,
      );
    } catch (err) {
      if (event.to === wipColumn && !commentPosted) {
        this.inProgressCommentClaims.delete(event.task.id);
      }
      const message = err instanceof Error ? err.message : String(err);
      await this.safeLogDeletedTaskEntry(
        event.task.id,
        "Failed to post GitHub tracking comment",
        message,
      );
    }
  }
}
