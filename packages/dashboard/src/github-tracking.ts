import {
  AiServiceError,
  MIN_DESCRIPTION_LENGTH,
  resolveTaskGithubTracking,
  summarizeTitle,
  type GlobalSettings,
  type ProjectSettings,
  type Task,
  type TaskStore,
} from "@fusion/core";
import type { CreatedIssue } from "./github.js";
import { GitHubClient } from "./github.js";
import { resolveGithubTrackingAuth } from "./github-auth.js";

const TRACKING_ISSUE_TITLE_LIMIT = 240;
const TRACKING_ISSUE_BODY_SUMMARY_LIMIT = 500;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateWithEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function deriveTitleFromDescription(description: string | undefined, maxLength: number): string | null {
  if (!description || !description.trim()) {
    return null;
  }

  const lines = description.split(/\r?\n/);
  const cleanedLines: string[] = [];
  let inCodeFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }

    let cleaned = line.trim();
    while (cleaned) {
      const next = cleaned
        .replace(/^>\s*/, "")
        .replace(/^#{1,6}\s+/, "")
        .replace(/^(?:[-*+]\s+|\d+\.\s+)/, "");
      if (next === cleaned) {
        break;
      }
      cleaned = next.trimStart();
    }

    cleanedLines.push(cleaned);
  }

  const firstLine = cleanedLines.find((line) => line.trim().length > 0);
  if (!firstLine) {
    return null;
  }

  const terminatorMatch = /[.!?](?=\s|$)/.exec(firstLine);
  const candidate = terminatorMatch
    ? firstLine.slice(0, terminatorMatch.index + 1)
    : firstLine;
  const collapsed = collapseWhitespace(candidate);

  if (!collapsed) {
    return null;
  }

  return truncateWithEllipsis(collapsed, maxLength);
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

export function formatTrackingIssueTitle(task: Pick<Task, "id" | "title" | "description">): string {
  const prefix = `[${task.id}] `;
  const maxTitleLength = Math.max(1, TRACKING_ISSUE_TITLE_LIMIT - prefix.length);
  const baseTitle = collapseWhitespace(task.title ?? "")
    || deriveTitleFromDescription(task.description, maxTitleLength)
    || "Untitled task";

  return `${prefix}${truncateWithEllipsis(baseTitle, maxTitleLength)}`;
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
  rootDir: string;
  logger?: Pick<Console, "warn" | "info">;
}

export type MaybeCreateTrackingIssueReason =
  | "tracking_disabled"
  | "issue_already_linked"
  | "no_repo_configured"
  | "no_title_available"
  | "github_error"
  | "auth_token_missing"
  | "auth_gh_not_installed"
  | "auth_gh_not_authenticated"
  | "auth_invalid_mode";

function resolveTrackingTitleSummarizerModel(
  projectSettings: ProjectSettings,
  globalSettings: GlobalSettings,
): { provider?: string; modelId?: string } {
  const candidates = [
    {
      provider: projectSettings.titleSummarizerProvider,
      modelId: projectSettings.titleSummarizerModelId,
    },
    {
      provider: globalSettings.titleSummarizerGlobalProvider,
      modelId: globalSettings.titleSummarizerGlobalModelId,
    },
    {
      provider: projectSettings.titleSummarizerFallbackProvider,
      modelId: projectSettings.titleSummarizerFallbackModelId,
    },
  ];

  for (const candidate of candidates) {
    if (candidate.provider && candidate.modelId) {
      return candidate;
    }
  }

  return {};
}

export async function maybeCreateTrackingIssue(
  task: Task,
  deps: MaybeCreateTrackingIssueDeps,
): Promise<{ created: false; reason: MaybeCreateTrackingIssueReason } | { created: true; issue: CreatedIssue }> {
  const inlineTracking = task.githubTracking;
  const resolvedTracking = resolveTaskGithubTracking(task, deps.projectSettings, deps.globalSettings);
  if (!resolvedTracking.enabled) {
    return { created: false, reason: "tracking_disabled" };
  }

  if (inlineTracking?.issue) {
    return { created: false, reason: "issue_already_linked" };
  }

  let latestTask = task;
  if (typeof deps.taskStore.getTask === "function") {
    try {
      const loadedTask = await deps.taskStore.getTask(task.id);
      if (loadedTask) {
        latestTask = loadedTask;
      }
    } catch {
      // Best-effort refresh only; continue with provided task if lookup fails.
    }
  }

  const tracking = latestTask.githubTracking ?? inlineTracking;
  if (tracking?.issue) {
    return { created: false, reason: "issue_already_linked" };
  }

  if (tracking?.enabled !== true) {
    latestTask = await deps.taskStore.updateGithubTracking(task.id, {
      ...(tracking ?? {}),
      enabled: true,
    });
  }

  const repo = resolvedTracking.repo;

  if (!repo) {
    deps.logger?.warn?.(`[github-tracking] No repo configured for ${task.id}`);
    await deps.taskStore.recordActivity({
      type: "task:updated",
      taskId: task.id,
      taskTitle: latestTask.title,
      details: "GitHub tracking issue not created: no repository configured",
      metadata: { type: "github-tracking-no-repo" },
    });
    return { created: false, reason: "no_repo_configured" };
  }

  const titleMissing = collapseWhitespace(latestTask.title ?? "").length === 0;
  const resolvedSummarizer = resolveTrackingTitleSummarizerModel(deps.projectSettings, deps.globalSettings);
  const canSummarizeTitle = titleMissing
    && typeof latestTask.description === "string"
    && latestTask.description.length >= MIN_DESCRIPTION_LENGTH
    && Boolean(resolvedSummarizer.provider && resolvedSummarizer.modelId);

  if (canSummarizeTitle) {
    try {
      const generatedTitle = await summarizeTitle(
        latestTask.description,
        deps.rootDir,
        resolvedSummarizer.provider,
        resolvedSummarizer.modelId,
      );

      if (generatedTitle) {
        const updatedTask = await deps.taskStore.updateTask(task.id, { title: generatedTitle });
        task.title = updatedTask.title;
        latestTask = updatedTask;
        await deps.taskStore.recordActivity({
          type: "task:updated",
          taskId: task.id,
          taskTitle: updatedTask.title,
          details: "Generated task title for GitHub tracking issue",
          metadata: { type: "github-tracking-title-summarized" },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const prefix = error instanceof AiServiceError
        ? "AI title summarizer failed"
        : "Title summarizer failed";
      deps.logger?.warn?.(`[github-tracking] ${task.id}: ${prefix}: ${message}`);
    }
  }

  const effectiveTitle = collapseWhitespace(latestTask.title ?? "")
    || deriveTitleFromDescription(latestTask.description, TRACKING_ISSUE_TITLE_LIMIT - `[${task.id}] `.length);

  if (!effectiveTitle) {
    deps.logger?.info?.(`[github-tracking] ${task.id}: deferred — no usable title; waiting for title or summarizer`);
    await deps.taskStore.recordActivity({
      type: "task:updated",
      taskId: task.id,
      taskTitle: latestTask.title,
      details: "GitHub tracking issue not created: task has no title yet",
      metadata: { type: "github-tracking-no-title" },
    });
    return { created: false, reason: "no_title_available" };
  }

  const resolution = resolveGithubTrackingAuth({
    projectSettings: deps.projectSettings,
    globalSettings: deps.globalSettings,
  });

  if (!resolution.ok) {
    deps.logger?.warn?.(`[github-tracking] ${task.id}: auth unavailable (${resolution.reason}): ${resolution.message}`);
    await deps.taskStore.recordActivity({
      type: "task:updated",
      taskId: task.id,
      taskTitle: latestTask.title,
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

  const title = formatTrackingIssueTitle(latestTask);
  const body = formatTrackingIssueBody(latestTask);

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
      taskTitle: latestTask.title,
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
    await deps.taskStore.recordActivity({
      type: "task:updated",
      taskId: task.id,
      taskTitle: latestTask.title,
      details: `GitHub tracking issue not created: ${message}`,
      metadata: {
        type: "github-issue-failed",
        reason: "github_error",
        message,
      },
    });
    return { created: false, reason: "github_error" };
  }
}
