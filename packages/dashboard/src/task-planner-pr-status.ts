import type { PrInfo, Task, TaskStore } from "@fusion/core";
import { getCurrentRepo } from "@fusion/core";
import { parseBadgeUrl } from "./github.js";

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

  /*
  FNXC:PullRequestReadiness 2026-10-04-23:13:
  Chat is a consumer of the same stored snapshot as lifecycle automation. A
  chat request must not fetch GitHub independently because a delayed provider
  response could present A-head approval after the reconciler has fenced B.
  */
  try {
    const entity = await store.getPrEntityByNumber(`${repository.owner}/${repository.repo}`, prior.number);
    const snapshot = entity?.readiness;
    if (!entity || !snapshot || snapshot.observedHeadOid !== entity.headOid) {
      return {
        availability: "refresh-error",
        pr: { number: prior.number, url: prior.url, state: prior.status, headSha: prior.headOid, headBranch: prior.headBranch, baseBranch: prior.baseBranch },
        checks: [], blockers: [], stale: true, lastCheckedAt: prior.lastCheckedAt,
        error: "Current-head pull request readiness has not been observed.",
      };
    }
    const rollup = snapshot.requiredChecks.some((check) => check.state === "failure") ? "failure"
      : snapshot.requiredChecks.some((check) => check.state !== "success") ? "pending"
        : snapshot.requiredChecks.length > 0 ? "success" : "none";
    const capabilityBlockers = [snapshot.checks, snapshot.reviews, snapshot.merge, snapshot.deployments, snapshot.branchUpdate]
      .filter((capability) => capability.state !== "supported")
      .map((capability) => `capability ${capability.state}${capability.reason ? `: ${capability.reason}` : ""}`);
    return {
      availability: "fresh",
      pr: { number: prior.number, url: prior.url, state: snapshot.state, headSha: snapshot.observedHeadOid, headBranch: prior.headBranch, baseBranch: prior.baseBranch },
      rollup,
      checks: snapshot.requiredChecks.slice(0, MAX_CHECKS).map((check) => ({ name: check.name, required: true, state: check.state })),
      reviewDecision: snapshot.approval === "approved" ? "APPROVED" : snapshot.approval === "changes-requested" ? "CHANGES_REQUESTED" : snapshot.approval === "review-required" ? "REVIEW_REQUIRED" : null,
      mergeable: snapshot.mergeable,
      blockers: [...snapshot.protectionBlockers, ...capabilityBlockers].slice(0, MAX_BLOCKERS),
      lastCheckedAt: snapshot.observedAt,
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
