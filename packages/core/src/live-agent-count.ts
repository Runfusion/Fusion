import { ACTIVE_MERGE_PIPELINE_STATUSES } from "./active-merge-status.js";
import type { Task } from "./types.js";

export type RunningAgentCountSource = (projectIds: readonly string[]) => Promise<Record<string, number>> | Record<string, number>;

type RunningAgentTaskShape = Pick<Task, "column" | "status" | "paused">;

/*
FNXC:MergeQueue 2026-07-15-10:40:
In-review live agents include the full AI merge pipeline (merging/reviewing/landing) plus fix-pass and generic fixing statuses so utilization counts stay honest during clean-room review and land.
*/
const ACTIVE_IN_REVIEW_AGENT_STATUSES = new Set([
  ...ACTIVE_MERGE_PIPELINE_STATUSES,
  "fixing",
]);

let runningAgentCountSource: RunningAgentCountSource | undefined;

/**
 * FNXC:GlobalConcurrencyControls 2026-06-26-17:22:
 * Live running-agent counts must come from side-effect-safe reads of `in-progress` task columns, not from stale slot or health bookkeeping. This DI seam lets dashboard, CLI, remote-node, and plugin consumers share one core path without starting project engines/runtimes, opening watchers, or mutating `globalConcurrency.currentlyActive`, `globalConcurrency.queuedCount`, or `projectHealth.inFlightAgentCount`.
 */
export function setRunningAgentCountSource(fn: RunningAgentCountSource | undefined): void {
  runningAgentCountSource = fn;
}

/**
 * Returns the registered side-effect-safe running-agent count source, if one has been wired by the host process.
 */
export function getRunningAgentCountSource(): RunningAgentCountSource | undefined {
  return runningAgentCountSource;
}

export interface RunningAgentCounts {
  currentlyActive: number;
  projectsActive: Record<string, number>;
}

/**
 * FNXC:GlobalConcurrencyControls 2026-06-27-00:00:
 * FN-7160 defines live running-agent counts as top-level concurrency slot holders: in-progress executors, active unpaused triage planners, and active unpaused in-review reviewer/merger/fix agents, including PR/fix merge substates. Keep this pure predicate as the shared source of truth for engine slot accounting and all dashboard/CLI read-layer count surfaces so in-review agents cannot drift out of utilization displays again.
 */
export function isRunningAgentTask(task: RunningAgentTaskShape): boolean {
  if (task.column === "in-progress") {
    return true;
  }

  if (task.column === "triage") {
    return task.status === "planning" && !task.paused;
  }

  if (task.column === "in-review") {
    return ACTIVE_IN_REVIEW_AGENT_STATUSES.has(String(task.status ?? "")) && !task.paused;
  }

  return false;
}

export function countRunningAgentTasks(tasks: readonly RunningAgentTaskShape[]): number {
  return tasks.filter(isRunningAgentTask).length;
}

export function deriveRunningAgentCounts(perProject: Record<string, number>): RunningAgentCounts {
  const projectsActive: Record<string, number> = {};
  let currentlyActive = 0;

  for (const [projectId, rawCount] of Object.entries(perProject)) {
    const count = Number.isFinite(rawCount) ? Math.max(0, Math.trunc(rawCount)) : 0;
    currentlyActive += count;
    if (count > 0) {
      projectsActive[projectId] = count;
    }
  }

  return { currentlyActive, projectsActive };
}
