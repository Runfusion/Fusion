import type { PrInfo, Task, TaskStore } from "@fusion/core";
import { createIngestedCheckResolver, resolveRequiredCheckNames } from "@fusion/core";
import { getCurrentRepo } from "@fusion/core";
import { GitHubClient, parseBadgeUrl, type PrCheckStatus } from "./github.js";
import { githubRateLimiter } from "./github-poll.js";

const MAX_CHECKS = 50;
const MAX_BLOCKERS = 20;

export type TaskPlannerPrStatus = {
  availability: "fresh" | "no-linked-pr" | "refresh-error";
  pr?: {
    number: number;
    url: string;
    state: string;
    headSha?: string;
    headBranch: string;
    baseBranch: string;
  };
  rollup?: "success" | "failure" | "pending" | "none";
  checks: Array<{ name: string; required: boolean; state: string }>;
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeable?: string;
  blockers: string[];
  lastCheckedAt?: string;
  stale: boolean;
  error?: string;
};

type TaskWithPrs = Pick<Task, "prInfo" | "prInfos">;

/** Keep the task detail tool and Pull Request routes on the same persisted primary-PR convention. */
export function getTaskPrimaryPr(task: TaskWithPrs): PrInfo | undefined {
  return task.prInfos?.[0] ?? task.prInfo;
}

function rollupChecks(checks: PrCheckStatus[]): "success" | "failure" | "pending" | "none" {
  const required = checks.filter((check) => check.required);
  if (required.length === 0) return "none";
  if (required.some((check) => ["failure", "failed", "error", "cancelled", "timed_out"].includes(check.state.toLowerCase()))) return "failure";
  if (required.some((check) => !["success", "neutral", "skipped"].includes(check.state.toLowerCase()))) return "pending";
  return "success";
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

function resolveRepository(store: TaskStore, pr: PrInfo): { owner: string; repo: string } | null {
  const badge = parseBadgeUrl(pr.url);
  if (badge) return badge;
  const envRepo = process.env.GITHUB_REPOSITORY;
  if (envRepo) {
    const [owner, repo] = envRepo.split("/");
    if (owner && repo) return { owner, repo };
  }
  return getCurrentRepo(store.getRootDir()) ?? null;
}

/*
FNXC:TaskDetailChatPrStatus 2026-09-29-06:58:
Task-detail Chat must read the same live GitHub review/check aggregation that backs the Pull Request
surface, while keeping task selection server-bound. The bounded result intentionally excludes forge
credentials, review bodies, check logs, and other task data; a failed refresh is explicit rather than
being replaced by local Git inference.
*/
export async function resolveTaskPlannerPrStatus(store: TaskStore, taskId: string): Promise<TaskPlannerPrStatus> {
  const task = await store.getTask(taskId);
  const prior = getTaskPrimaryPr(task);
  if (!prior) {
    return { availability: "no-linked-pr", checks: [], blockers: [], stale: false };
  }

  const repository = resolveRepository(store, prior);
  if (!repository) {
    return {
      availability: "refresh-error",
      pr: { number: prior.number, url: prior.url, state: prior.status, headSha: prior.headOid, headBranch: prior.headBranch, baseBranch: prior.baseBranch },
      checks: [], blockers: [], stale: true, lastCheckedAt: prior.lastCheckedAt,
      error: "Could not determine the linked pull request repository.",
    };
  }

  if (!githubRateLimiter.canMakeRequest(`${repository.owner}/${repository.repo}`)) {
    return {
      availability: "refresh-error",
      pr: { number: prior.number, url: prior.url, state: prior.status, headSha: prior.headOid, headBranch: prior.headBranch, baseBranch: prior.baseBranch },
      rollup: prior.checkRollup, checks: [], reviewDecision: prior.lastReviewDecision, mergeable: prior.mergeable,
      blockers: [], stale: true, lastCheckedAt: prior.lastCheckedAt,
      error: "GitHub rate limit prevents a current pull request status refresh.",
    };
  }

  try {
    const settings = await store.getSettings();
    const resolveIngestedChecks = createIngestedCheckResolver(store.getAsyncLayer?.());
    const checkOptions = { requiredCheckNames: resolveRequiredCheckNames(settings), ...(resolveIngestedChecks ? { resolveIngestedChecks } : {}) };
    const snapshot = await new GitHubClient().getPrReviewSnapshot(repository.owner, repository.repo, prior.number, checkOptions);
    const now = new Date().toISOString();
    const rollup = snapshot.prInfo.checkRollup ?? rollupChecks(snapshot.checks);
    const prInfo: PrInfo = {
      ...prior,
      ...snapshot.prInfo,
      checkRollup: rollup,
      lastCheckedAt: now,
      lastReviewDecision: snapshot.decision,
    };
    await store.updatePrInfoByNumber(taskId, prior.number, prInfo);
    const checks = snapshot.checks.slice(0, MAX_CHECKS).map((check) => ({ name: check.name, required: check.required, state: check.state }));
    return {
      availability: "fresh",
      pr: { number: prInfo.number, url: prInfo.url, state: prInfo.status, headSha: prInfo.headOid, headBranch: prInfo.headBranch, baseBranch: prInfo.baseBranch },
      rollup,
      checks,
      reviewDecision: snapshot.decision,
      mergeable: prInfo.mergeable,
      blockers: (snapshot.summary?.blockingReasons ?? []).slice(0, MAX_BLOCKERS),
      lastCheckedAt: now,
      stale: false,
    };
  } catch (error) {
    return {
      availability: "refresh-error",
      pr: { number: prior.number, url: prior.url, state: prior.status, headSha: prior.headOid, headBranch: prior.headBranch, baseBranch: prior.baseBranch },
      rollup: prior.checkRollup, checks: [], reviewDecision: prior.lastReviewDecision, mergeable: prior.mergeable,
      blockers: [], stale: true, lastCheckedAt: prior.lastCheckedAt,
      error: formatError(error),
    };
  }
}

export function formatTaskPlannerPrStatus(status: TaskPlannerPrStatus): string {
  if (status.availability === "no-linked-pr") return "No pull request is linked to the current task.";
  if (status.availability === "refresh-error") {
    return `Pull request status is stale or unavailable: ${status.error ?? "refresh failed"}${status.lastCheckedAt ? ` Last checked: ${status.lastCheckedAt}.` : ""}`;
  }
  const checks = status.checks.length === 0
    ? "none reported"
    : status.checks.map((check) => `${check.required ? "required " : ""}${check.name}: ${check.state}`).join("; ");
  return [
    `PR #${status.pr?.number ?? "unknown"} (${status.pr?.state ?? "unknown"})`,
    `Head SHA: ${status.pr?.headSha ?? "unavailable"}`,
    `Required-check rollup: ${status.rollup ?? "unknown"}`,
    `Checks: ${checks}`,
    `Review decision: ${status.reviewDecision ?? "unavailable"}`,
    `Mergeability: ${status.mergeable ?? "unknown"}`,
    `Blockers: ${status.blockers.length > 0 ? status.blockers.join("; ") : "none reported"}`,
    `Last checked: ${status.lastCheckedAt ?? "unavailable"}`,
  ].join("\n");
}
