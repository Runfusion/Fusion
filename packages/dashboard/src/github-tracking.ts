import {
  AiServiceError,
  columnsWithFlag,
  declaresAnyLifecycleTrait,
  parseRepoSlug,
  resolveTaskGithubTracking,
  resolveTaskOutputLanguage,
  resolveWorkflowIrForTask,
  summarizeTitle,
  type GlobalSettings,
  type ProjectSettings,
  type Task,
  type TaskStore,
} from "@fusion/core";
import type { CreatedIssue } from "./github.js";
import { GitHubClient, isGitHubIssueAlreadyImported } from "./github.js";
import { resolveGithubTrackingAuth } from "./github-auth.js";
import {
  buildIssueSearchQueries,
  DEDUP_MATCH_THRESHOLD,
  extractFileScopePaths,
  extractSymptomKeywords,
  scoreCandidateIssue,
} from "./github-tracking-dedup.js";

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

export async function resolveImportedIssueGithubTracking(
  store: TaskStore,
  projectSettings: ProjectSettings,
): Promise<{ enabled: true } | undefined> {
  if (projectSettings.githubLinkImportedIssuesToTracking === true) return { enabled: true };
  const globalSettings = await store.getGlobalSettingsStore().getSettings();
  return resolveTaskGithubTracking({ githubTracking: undefined }, projectSettings, globalSettings).enabled ? { enabled: true } : undefined;
}

/*
FNXC:GitHubPlanningSourceIssue 2026-08-09-05:36:
Create-time serialization narrows same-process races, but shared database nodes can still race.
Source adoption rechecks after linking and deterministically suppresses the loser so one issue has one tracker.
*/
const planningSourceIssueLocks = new Map<string, Promise<unknown>>();
function sourceIssueKey(store: TaskStore, issue: { owner: string; repo: string; number: number }): string {
  return `github-source-tracking:${(store as unknown as { projectId?: string }).projectId ?? "__legacy_unscoped__"}:${issue.owner.toLowerCase()}/${issue.repo.toLowerCase()}#${issue.number}`;
}
async function withSourceIssueLock<T>(store: TaskStore, issue: { owner: string; repo: string; number: number }, action: () => Promise<T>): Promise<T> {
  const key = sourceIssueKey(store, issue);
  const previous = planningSourceIssueLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  planningSourceIssueLocks.set(key, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (planningSourceIssueLocks.get(key) === queued) planningSourceIssueLocks.delete(key);
  }
}
function liveIssueHolders(tasks: Task[], taskId: string, issue: { owner: string; repo: string; number: number; url: string }): Task[] {
  return tasks.filter((candidate) => candidate.id !== taskId && isGitHubIssueAlreadyImported(candidate, { owner: issue.owner, repo: issue.repo, issueNumber: issue.number, sourceUrl: issue.url }));
}
export async function resolvePlanningGithubTrackingDecision(store: TaskStore, projectSettings: ProjectSettings, sourceIssueInput: { owner: string; repo: string; issueNumber: number; url: string }): Promise<{ githubTracking?: { enabled: true }; suppressedByTaskId?: string }> {
  const issue = { owner: sourceIssueInput.owner, repo: sourceIssueInput.repo, number: sourceIssueInput.issueNumber };
  return withSourceIssueLock(store, issue, async () => {
    const tasks = await store.listTasks({ slim: false, includeArchived: false });
    const holder = liveIssueHolders(tasks, "", { ...issue, url: sourceIssueInput.url })[0];
    if (holder) return { suppressedByTaskId: holder.id };
    return (await resolveImportedIssueGithubTracking(store, projectSettings)) ? { githubTracking: { enabled: true } } : {};
  });
}

export async function adoptGithubSourceIssueExclusively(store: TaskStore, taskId: string, issue: { owner: string; repo: string; number: number; url: string }): Promise<{ adopted: boolean; holderTaskId?: string }> {
  // Legacy unit adapters predate listTasks; retain their established single-task adoption behavior.
  if (typeof store.listTasks !== "function") {
    await store.linkGithubIssue(taskId, { owner: issue.owner, repo: issue.repo, number: issue.number, url: issue.url, createdAt: new Date().toISOString() });
    return { adopted: true };
  }
  return withSourceIssueLock(store, issue, async () => {
    const all = await store.listTasks({ slim: false, includeArchived: false });
    const linked = all.filter((task) => task.id !== taskId && task.githubTracking?.issue
      && task.githubTracking.issue.owner.toLowerCase() === issue.owner.toLowerCase()
      && task.githubTracking.issue.repo.toLowerCase() === issue.repo.toLowerCase()
      && task.githubTracking.issue.number === issue.number);
    // A pre-existing link is authoritative even when this task is older: never steal a live stream.
    if (linked.length > 0) {
      const holder = linked.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]!;
      if (all.find((task) => task.id === taskId)?.githubTracking?.issue) {
        await store.unlinkGithubIssue(taskId);
      }
      await store.updateGithubTracking(taskId, { enabled: false });
      return { adopted: false, holderTaskId: holder.id };
    }
    /*
    FNXC:GitHubPlanningSourceIssue 2026-08-09-08:09:
    Layer 1 suppresses any existing provenance holder, not only an already-enabled tracker.
    Keep that rule in Layer 2 too: the post-create hook can otherwise re-enable a
    Layer-1-suppressed task through project defaults before exclusive adoption runs.
    */
    const candidates = liveIssueHolders(all, taskId, issue);
    const winner = [all.find((task) => task.id === taskId), ...candidates]
      .filter((task): task is Task => Boolean(task))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
    if (winner?.id !== taskId) {
      if (all.find((task) => task.id === taskId)?.githubTracking?.issue) {
        await store.unlinkGithubIssue(taskId);
      }
      await store.updateGithubTracking(taskId, { enabled: false });
      return { adopted: false, holderTaskId: winner.id };
    }
    await store.linkGithubIssue(taskId, { owner: issue.owner, repo: issue.repo, number: issue.number, url: issue.url, createdAt: new Date().toISOString() });
    const after = await store.listTasks({ slim: false, includeArchived: false });
    const linkedAfter = after.filter((task) => task.githubTracking?.issue && task.githubTracking.issue.owner.toLowerCase() === issue.owner.toLowerCase() && task.githubTracking.issue.repo.toLowerCase() === issue.repo.toLowerCase() && task.githubTracking.issue.number === issue.number).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (linkedAfter[0]?.id !== taskId) {
      await store.unlinkGithubIssue(taskId);
      await store.updateGithubTracking(taskId, { enabled: false });
      return { adopted: false, holderTaskId: linkedAfter[0]?.id };
    }
    return { adopted: true };
  });
}

export type MaybeCreateTrackingIssueReason =
  | "tracking_disabled"
  | "issue_already_linked"
  | "no_repo_configured"
  | "no_title_available"
  | "existing_issue_found"
  | "source_issue_linked"
  | "source_issue_already_tracked_elsewhere"
  | "github_error"
  | "auth_token_missing"
  | "auth_gh_not_installed"
  | "auth_gh_not_authenticated"
  | "auth_invalid_mode";

/*
FNXC:GithubTracking 2026-08-15-22:27:
A tracking issue created after the Fusion task is already complete has no later task:moved event, so GitHubTrackingStateService never closes it. After create or dedup-link, close immediately when the task is already in a Complete lane. Failures are logged and never undo the link.
*/
async function closeTrackingIssueIfTaskAlreadyTerminal(
  task: Task,
  store: TaskStore,
  client: GitHubClient,
  issue: { owner: string; repo: string; number: number },
): Promise<void> {
  const latest = typeof store.getTask === "function"
    ? ((await store.getTask(task.id).catch(() => task)) ?? task)
    : task;
  const ir = await resolveWorkflowIrForTask(store, latest.id).catch(() => undefined);
  const traitsExpressed = ir !== undefined && declaresAnyLifecycleTrait(ir);
  const completeLanes = ir === undefined || !traitsExpressed ? ["done"] : columnsWithFlag(ir, "complete");
  const isComplete = completeLanes.includes(latest.column);
  if (!isComplete) {
    return;
  }

  try {
    const existing = await client.getIssue(issue.owner, issue.repo, issue.number);
    if (!existing || existing.state === "closed") {
      return;
    }
    await client.setIssueState(issue.owner, issue.repo, issue.number, "closed", "completed");
    if (typeof store.logEntry === "function") {
      await store.logEntry(latest.id, "Closed linked GitHub tracking issue", `${issue.owner}/${issue.repo}#${issue.number}`);
    }
    if (typeof store.recordActivity === "function") {
      await store.recordActivity({
        type: "task:updated",
        taskId: latest.id,
        taskTitle: latest.title,
        details: `Closed linked GitHub tracking issue ${issue.owner}/${issue.repo}#${issue.number} because the task is already ${latest.column}`,
        metadata: {
          type: "github-issue-closed-already-terminal",
          repo: `${issue.owner}/${issue.repo}`,
          number: issue.number,
        },
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (typeof store.logEntry === "function") {
      await store.logEntry(latest.id, "Failed to close GitHub tracking issue", message);
    }
  }
}

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
    deps.logger?.info?.(`[github-tracking] ${task.id}: skipped (tracking_disabled)`);
    return { created: false, reason: "tracking_disabled" };
  }

  if (inlineTracking?.issue) {
    deps.logger?.info?.(`[github-tracking] ${task.id}: skipped (issue_already_linked)`);
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
    deps.logger?.info?.(`[github-tracking] ${task.id}: skipped (issue_already_linked)`);
    return { created: false, reason: "issue_already_linked" };
  }

  if (tracking?.enabled !== true) {
    latestTask = await deps.taskStore.updateGithubTracking(task.id, {
      ...(tracking ?? {}),
      enabled: true,
    });
  }

  const sourceIssue = latestTask.sourceIssue;
  if (sourceIssue?.provider === "github") {
    const sourceRepo = parseRepoSlug(sourceIssue.repository);
    if (sourceRepo && Number.isFinite(sourceIssue.issueNumber)) {
      const url = sourceIssue.url
        ?? `https://github.com/${sourceRepo.owner}/${sourceRepo.repo}/issues/${sourceIssue.issueNumber}`;
      const adoption = await adoptGithubSourceIssueExclusively(deps.taskStore, task.id, {
        owner: sourceRepo.owner, repo: sourceRepo.repo, number: sourceIssue.issueNumber, url,
      });
      if (!adoption.adopted) {
        await deps.taskStore.logEntry(task.id, `Source issue already tracked by ${adoption.holderTaskId ?? "another task"}`);
        return { created: false, reason: "source_issue_already_tracked_elsewhere" };
      }
      await deps.taskStore.recordActivity({
        type: "task:updated",
        taskId: task.id,
        taskTitle: latestTask.title,
        details: `Linked source issue ${sourceRepo.owner}/${sourceRepo.repo}#${sourceIssue.issueNumber}`,
        metadata: {
          type: "github-issue-source-linked",
          repo: `${sourceRepo.owner}/${sourceRepo.repo}`,
          number: sourceIssue.issueNumber,
          htmlUrl: url,
        },
      });
      return { created: false, reason: "source_issue_linked" };
    }
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
  /*
  FNXC:TitleSummarization 2026-08-19-13:43:
  Tracking title generation uses the shared summarizer for every non-empty titleless task.
  The project setting controls ordinary create-time automation; this configured tracking lane
  retains its existing explicit integration behavior without a hidden length threshold.
  */
  const canSummarizeTitle = titleMissing
    && typeof latestTask.description === "string"
    && latestTask.description.trim().length > 0
    && Boolean(resolvedSummarizer.provider && resolvedSummarizer.modelId);

  if (canSummarizeTitle) {
    try {
      /* FNXC:TaskOutputLanguage 2026-08-19-15:36: GitHub tracking snapshots task prose language before its asynchronous title call. */
      const generatedTitle = await summarizeTitle(
        latestTask.description,
        deps.rootDir,
        resolvedSummarizer.provider,
        resolvedSummarizer.modelId,
        resolveTaskOutputLanguage({ ...deps.globalSettings, ...deps.projectSettings }, latestTask.description),
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

  /*
  FNXC:GithubTracking 2026-07-05-00:00:
  Tracking-issue dedup was mis-linking new tasks to OLD/STALE issues (operator report: FN-7579 got an old issue id instead of a fresh one).
  Two false-positive vectors, both fixed here:
    1. Search included CLOSED issues (state: "all"), so a resolved tracking issue from an earlier, unrelated task could be reused. Dedup only exists to avoid opening a *second live* issue for the same active work — a closed/resolved issue must never be reused. We now search and accept OPEN issues only.
    2. The accept filter allowed a keyword-only match (matchedKeywords >= 2 with zero file-path overlap). Symptom keywords are generic camelCase identifiers shared across many tasks (e.g. `githubTracking`, `trackingIssue`), so 2-3 shared tokens is a weak signal that routinely mis-matched. We now require at least one File-Scope path overlap before reusing an issue; keyword count only breaks ties / raises confidence.
  Net effect: a task with no File-Scope paths (or no OPEN path-overlapping issue) always creates a fresh tracking issue rather than mis-linking. See docs/triage-duplicate-detection-postmortem.md.
  */
  if (deps.projectSettings.githubTrackingDedupEnabled !== false) {
    try {
      const paths = extractFileScopePaths(latestTask as Task & { prompt?: string });
      const keywords = extractSymptomKeywords(latestTask, { max: 6 });
      // FNXC:GithubTracking Path overlap is now mandatory for a dedup link — without File-Scope paths there is no strong-enough signal, so skip the search entirely and create fresh.
      if (paths.length > 0) {
        const queries = buildIssueSearchQueries(paths, keywords);
        const byNumber = new Map<number, {
          number: number;
          title: string;
          body: string | null;
          html_url: string;
          state: "open" | "closed";
          updatedAt?: string;
        }>();

        for (const query of queries) {
          const candidates = await githubClient.searchIssues(repo.owner, repo.repo, query, { state: "open", limit: 10 });
          for (const candidate of candidates) {
            // FNXC:GithubTracking Defensive: never reuse a closed/resolved issue even if the API returns one.
            if (candidate.state !== "open") continue;
            if (!byNumber.has(candidate.number)) {
              byNumber.set(candidate.number, candidate);
            }
          }

          const scored = [...byNumber.values()]
            .map((candidate) => ({ candidate, ...scoreCandidateIssue(candidate, paths, keywords) }))
            .filter((entry) => entry.score >= DEDUP_MATCH_THRESHOLD)
            .filter((entry) => entry.matchedPaths.length > 0)
            .sort((a, b) => b.score - a.score);

          const bestMatch = scored[0];
          if (bestMatch) {
            await deps.taskStore.linkGithubIssue(task.id, {
              owner: repo.owner,
              repo: repo.repo,
              number: bestMatch.candidate.number,
              url: bestMatch.candidate.html_url,
              createdAt: bestMatch.candidate.updatedAt ?? new Date().toISOString(),
            });

            await deps.taskStore.recordActivity({
              type: "task:updated",
              taskId: task.id,
              taskTitle: latestTask.title,
              details: `Linked existing issue ${repo.owner}/${repo.repo}#${bestMatch.candidate.number} (dedup match; see docs/triage-duplicate-detection-postmortem.md)`,
              metadata: {
                type: "github-issue-dedup-matched",
                repo: `${repo.owner}/${repo.repo}`,
                number: bestMatch.candidate.number,
                htmlUrl: bestMatch.candidate.html_url,
                score: bestMatch.score,
                matchedPaths: bestMatch.matchedPaths,
                matchedKeywords: bestMatch.matchedKeywords,
                state: bestMatch.candidate.state,
              },
            });

            await closeTrackingIssueIfTaskAlreadyTerminal(latestTask, deps.taskStore, githubClient, {
              owner: repo.owner,
              repo: repo.repo,
              number: bestMatch.candidate.number,
            });
            return { created: false, reason: "existing_issue_found" };
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger?.warn?.(`[github-tracking] ${task.id}: duplicate-search failed; falling back to issue creation: ${message}`);
    }
  }

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

    await closeTrackingIssueIfTaskAlreadyTerminal(latestTask, deps.taskStore, githubClient, {
      owner: repo.owner,
      repo: repo.repo,
      number: issue.number,
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
