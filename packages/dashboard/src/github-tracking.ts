import type { GlobalSettings, ProjectSettings, Task, TaskStore } from "@fusion/core";
import type { CreatedIssue } from "./github.js";
import { GitHubClient } from "./github.js";
import { resolveGithubTrackingAuth } from "./github-auth.js";

const TRACKING_ISSUE_TITLE_LIMIT = 240;
const TRACKING_ISSUE_BODY_SUMMARY_LIMIT = 500;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstNonEmptyParagraph(value: string | undefined): string | null {
  if (!value) return null;
  const paragraph = value
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return paragraph && paragraph.length > 0 ? paragraph : null;
}

function sanitizeSummaryText(value: string): string {
  const cleaned = value
    .split(/\r?\n/)
    .filter((line) => !/^```/.test(line.trim()))
    .map((line) => line.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*(?:[-*+]\s+|\d+\.\s+)/, ""))
    .join(" ");

  const withoutFusionUrls = cleaned
    .replace(/https?:\/\/localhost(?::\d+)?\/[^\s)]*/gi, " ")
    .replace(/https?:\/\/[^\s)]*\/tasks\/FN-\d+[^\s)]*/gi, " ");

  return collapseWhitespace(withoutFusionUrls);
}

export function formatTrackingIssueTitle(task: Pick<Task, "id" | "title">): string {
  const prefix = `[${task.id}] `;
  const baseTitle = collapseWhitespace(task.title ?? "") || "Untitled task";
  const maxTitleLength = Math.max(1, TRACKING_ISSUE_TITLE_LIMIT - prefix.length);

  if (baseTitle.length <= maxTitleLength) {
    return `${prefix}${baseTitle}`;
  }

  const truncated = `${baseTitle.slice(0, Math.max(0, maxTitleLength - 1)).trimEnd()}…`;
  return `${prefix}${truncated}`;
}

export function formatTrackingIssueBody(task: {
  id: string;
  title?: string;
  description?: string;
  summary?: string;
  prompt?: string;
}): string {
  const source = firstNonEmptyParagraph(task.description)
    ?? firstNonEmptyParagraph(task.prompt)
    ?? task.summary?.trim()
    ?? "No summary available.";

  const sanitized = sanitizeSummaryText(source) || "No summary available.";
  const summary = sanitized.length > TRACKING_ISSUE_BODY_SUMMARY_LIMIT
    ? `${sanitized.slice(0, TRACKING_ISSUE_BODY_SUMMARY_LIMIT - 1).trimEnd()}…`
    : sanitized;

  return `Fusion task: ${task.id}\n\n${summary}`;
}

export interface MaybeCreateTrackingIssueDeps {
  taskStore: TaskStore;
  projectSettings: ProjectSettings;
  globalSettings: GlobalSettings;
  logger?: Pick<Console, "warn" | "info">;
}

export type MaybeCreateTrackingIssueReason =
  | "tracking_disabled"
  | "issue_already_linked"
  | "github_import_source"
  | "no_repo_configured"
  | "github_error"
  | "auth_token_missing"
  | "auth_gh_not_installed"
  | "auth_gh_not_authenticated"
  | "auth_invalid_mode";

function parseRepo(value: string | undefined): { owner: string; repo: string } | null {
  if (!value) return null;
  const trimmed = value.trim();
  const [owner, repo, ...rest] = trimmed.split("/");
  if (!owner || !repo || rest.length > 0) return null;
  return { owner, repo };
}

export async function maybeCreateTrackingIssue(
  task: Task,
  deps: MaybeCreateTrackingIssueDeps,
): Promise<{ created: false; reason: MaybeCreateTrackingIssueReason } | { created: true; issue: CreatedIssue }> {
  const tracking = task.githubTracking;
  if (tracking?.enabled !== true) {
    return { created: false, reason: "tracking_disabled" };
  }

  if (tracking.issue) {
    return { created: false, reason: "issue_already_linked" };
  }

  if (task.sourceType === "github_import") {
    return { created: false, reason: "github_import_source" };
  }

  const repo =
    parseRepo(tracking.repoOverride) ??
    parseRepo(deps.projectSettings.githubTrackingDefaultRepo) ??
    parseRepo(deps.globalSettings.githubTrackingDefaultRepo);

  if (!repo) {
    deps.logger?.warn?.(`[github-tracking] No repo configured for ${task.id}`);
    await deps.taskStore.recordActivity({
      type: "task:updated",
      taskId: task.id,
      taskTitle: task.title,
      details: "GitHub tracking issue not created: no repository configured",
      metadata: { type: "github-tracking-no-repo" },
    });
    return { created: false, reason: "no_repo_configured" };
  }

  const resolution = resolveGithubTrackingAuth({
    projectSettings: deps.projectSettings,
    globalSettings: {},
  });

  if (!resolution.ok) {
    deps.logger?.warn?.(`[github-tracking] ${task.id}: auth unavailable (${resolution.reason}): ${resolution.message}`);
    await deps.taskStore.recordActivity({
      type: "task:updated",
      taskId: task.id,
      taskTitle: task.title,
      details: `GitHub tracking issue not created: ${resolution.message}`,
      metadata: {
        type: "github-issue-skipped",
        reason: resolution.reason,
        message: resolution.message,
      },
    });

    return { created: false, reason: `auth_${resolution.reason}` };
  }

  const githubClient = resolution.auth.mode === "token"
    ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
    : new GitHubClient({ forceMode: "gh-cli" });

  const title = formatTrackingIssueTitle(task);
  const body = formatTrackingIssueBody(task);

  try {
    const issue = await githubClient.createIssue({ owner: repo.owner, repo: repo.repo, title, body });

    await deps.taskStore.linkGithubIssue(task.id, {
      owner: repo.owner,
      repo: repo.repo,
      number: issue.number,
      url: issue.htmlUrl,
      createdAt: issue.createdAt,
    });

    await deps.taskStore.recordActivity({
      type: "task:updated",
      taskId: task.id,
      taskTitle: task.title,
      details: `Linked tracking issue ${repo.owner}/${repo.repo}#${issue.number}`,
      metadata: {
        type: "github-issue-created",
        repo: `${repo.owner}/${repo.repo}`,
        number: issue.number,
        htmlUrl: issue.htmlUrl,
      },
    });

    return { created: true, issue };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger?.warn?.(`[github-tracking] Failed to create issue for ${task.id} in ${repo.owner}/${repo.repo}: ${message}`);
    return { created: false, reason: "github_error" };
  }
}
