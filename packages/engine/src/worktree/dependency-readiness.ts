import type { Settings } from "@fusion/core";
import {
  describeDependencySyncDecision,
  installWorktreeDependencies,
  type WorktreeDependencySyncLogger,
  type WorktreeDependencySyncResult,
} from "../merge/merge-dependency-sync.js";

export interface WorktreeDependencyReadinessOptions {
  cwd: string;
  settings?: Pick<Settings, "worktreeInitCommand"> | null;
  taskId: string;
  signal?: AbortSignal;
  logger?: WorktreeDependencySyncLogger;
  context?: string;
  /** Test seam; production always delegates to the shared merge dependency helper. */
  install?: typeof installWorktreeDependencies;
}

export interface WorktreeDependencyReadiness {
  result: WorktreeDependencySyncResult;
  decision: string;
}

/** Build the one task-log decision line, retaining repository identity for workspace children. */
export function formatWorktreeDependencyReadinessLog(decision: string, repoRelPath?: string): string {
  return `Worktree dependency readiness${repoRelPath ? ` [${repoRelPath}]` : ""}: ${decision}`;
}

/*
FNXC:WorktreeDependencyReadiness 2026-08-29-06:46:
Task worktrees must resolve install readiness before an implementation session begins. Reuse the
AI-merge clean-room helper so lockfile inference, marker skipping, development dependency hygiene,
lockfile healing, timeout, and abort behavior cannot drift between task execution and landing.
*/
export async function ensureWorktreeDependencyReadiness(
  options: WorktreeDependencyReadinessOptions,
): Promise<WorktreeDependencyReadiness> {
  const install = options.install ?? installWorktreeDependencies;
  const result = await install({
    cwd: options.cwd,
    settings: options.settings,
    taskId: options.taskId,
    signal: options.signal,
    logger: options.logger,
    context: options.context ?? "for task worktree",
  });
  return { result, decision: describeDependencySyncDecision(result) };
}
