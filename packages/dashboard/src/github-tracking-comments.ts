import type { GlobalSettings, MergeDetails, ProjectSettings, Task, TaskStore } from "@fusion/core";
import { deriveTitleFromDescription } from "./github-tracking.js";
import { GitHubClient } from "./github.js";
import { resolveGithubTrackingAuth } from "./github-auth.js";

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

function buildDoneComment(
  task: Pick<Task, "id" | "title" | "description" | "branch" | "mergeDetails">,
  linkContext?: TrackingLinkContext,
  options?: { includeCommitSubject?: boolean; includeFilesLine?: boolean },
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
): string {
  if (transition === "done") {
    let comment = buildDoneComment(task, linkContext, { includeCommitSubject: true, includeFilesLine: true });
    if (comment.length <= DONE_COMMENT_MAX_LENGTH) {
      return comment;
    }

    comment = buildDoneComment(task, linkContext, { includeCommitSubject: false, includeFilesLine: true });
    if (comment.length <= DONE_COMMENT_MAX_LENGTH) {
      return comment;
    }

    return buildDoneComment(task, linkContext, { includeCommitSubject: false, includeFilesLine: false });
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
        console.warn(`[github-tracking-comments] Unable to write log entry for deleted task ${taskId}: ${message}`);
        return;
      }
      throw error;
    }
  }

  private async handleTaskMoved(event: TaskMovedEvent): Promise<void> {
    if (event.from === event.to) {
      return;
    }

    if (event.to !== "in-progress" && event.to !== "done") {
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
        event.task.id,
        "Failed to post GitHub tracking comment",
        "Linked issue metadata is incomplete",
      );
      return;
    }

    const body = event.to === "done"
      ? formatTrackingComment(event.task, event.to, { owner, repo })
      : formatTrackingComment(event.task, event.to);

    try {
      const projectSettings = await this.store.getSettings() as Pick<ProjectSettings, "githubAuthMode" | "githubAuthToken">;
      const globalSettings = (await this.store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
      const resolution = resolveGithubTrackingAuth({ projectSettings, globalSettings });
      if (!resolution.ok) {
        await this.safeLogDeletedTaskEntry(event.task.id, "Skipped GitHub tracking comment", resolution.message);
        return;
      }

      const client = resolution.auth.mode === "token"
        ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
        : new GitHubClient({ forceMode: "gh-cli" });
      await client.commentOnIssue(owner, repo, number, body);
      await this.safeLogDeletedTaskEntry(
        event.task.id,
        "Posted GitHub tracking comment",
        `${owner}/${repo}#${number} (${event.to})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.safeLogDeletedTaskEntry(
        event.task.id,
        "Failed to post GitHub tracking comment",
        message,
      );
    }
  }
}
