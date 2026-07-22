import type { PrInfo, Task } from "../types.js";

export function getPrimaryPrInfo(task: Pick<Task, "prInfo" | "prInfos">): PrInfo | undefined {
  return task.prInfos?.[0] ?? task.prInfo;
}

/**
 * FNXC:PrAutoMergeGate 2026-06-28-00:33:
 * FN-7182: active in-review rows keep `prInfo`/`prInfos` even in slim task listings; only archived snapshots strip PR payloads.
 * This makes the manual-open-PR handoff check safe for project-engine and self-healing slim sweeps while supporting legacy single-PR and multi-PR shapes.
 *
 * FNXC:PrAutoMergeGate 2026-06-28-01:39:
 * A draft PR is still an active human handoff: GitHub has not closed or merged it, and Fusion must not auto-process the task around it.
 */
export function taskHasManualOpenPullRequest(task: Pick<Task, "prInfo" | "prInfos">): boolean {
  const prs = task.prInfos ?? (task.prInfo ? [task.prInfo] : []);
  return prs.some((pr) => pr.manual === true && (pr.status === "open" || pr.status === "draft"));
}
