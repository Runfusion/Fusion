import { existsSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLegacyWorkspaceWorktreeLayout, isStrictDescendantPath, resolveWorkspaceTaskWorktreeDir, type Settings, type Task, type TaskStore } from "@fusion/core";
import type { RunAuditor } from "../util/run-audit.js";
import {
  ActiveSessionWorktreeRemovalError,
  RemovalReason,
  removeWorktree,
} from "../worktree/worktree-backend.js";
import type { MergeWriteFence } from "./merge-write-fence.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { canonicalizePath } from "../worktree/worktree-pool.js";

export type LandedWorktreeCleanupOutcome =
  | "removed"
  | "nothing-to-remove"
  | "preserved-deliverable"
  | "preserved-unverifiable"
  | "preserved-active-session";

type LandedWorktreeCleanupStore = Pick<TaskStore, "updateTask" | "logEntry"> & Partial<Pick<TaskStore, "getSettings">>;

export interface CleanupLandedTaskWorktreeInput {
  store: LandedWorktreeCleanupStore;
  taskId: string;
  worktreePath: string | null | undefined;
  rootDir: string | null | undefined;
  landedSha?: string;
  source: string;
  audit?: RunAuditor;
  log?: (message: string) => void | Promise<void>;
  fence?: Pick<MergeWriteFence, "assertOwned">;
}

export interface CleanupLandedTaskWorktreeResult {
  outcome: LandedWorktreeCleanupOutcome;
  removed: boolean;
  preservedReason?: string;
}

function preservedOutcomeFor(error: unknown): Pick<CleanupLandedTaskWorktreeResult, "outcome" | "preservedReason"> {
  if (error instanceof ActiveSessionWorktreeRemovalError) {
    return { outcome: "preserved-active-session", preservedReason: "active-session" };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(": status probe failed (")) {
    return { outcome: "preserved-unverifiable", preservedReason: "unverifiable" };
  }
  return { outcome: "preserved-deliverable", preservedReason: "deliverable" };
}

async function recordPreservedOutcome(
  input: Pick<CleanupLandedTaskWorktreeInput, "store" | "taskId" | "log">,
  worktreePath: string,
  result: Pick<CleanupLandedTaskWorktreeResult, "outcome" | "preservedReason">,
): Promise<void> {
  const message = `Post-landing worktree cleanup preserved ${worktreePath}: ${result.preservedReason ?? result.outcome}`;
  try {
    if (input.log) {
      await input.log(message);
      return;
    }
    await input.store.logEntry(
      input.taskId,
      "Post-landing worktree cleanup preserved",
      message,
    );
  } catch {
    // Cleanup observability must not turn a durable landing into a failed merge.
  }
}

async function recordPointerClearPending(
  input: CleanupLandedTaskWorktreeInput,
  worktreePath: string,
  error: unknown,
): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  const message = `Post-landing worktree cleanup removed ${worktreePath}, but clearing the task worktree pointer is pending: ${detail}`;
  try {
    if (input.log) {
      await input.log(message);
      return;
    }
    await input.store.logEntry(
      input.taskId,
      "Post-landing worktree cleanup pointer clear pending",
      message,
    );
  } catch {
    // Cleanup observability must not turn a durable landing into a failed merge.
  }
}

/*
FNXC:WorktreeCleanup 2026-08-29-01:50:
FN-251's removed outcome requires both filesystem deletion and a cleared durable worktree pointer.
A transient pointer write failure stays non-fatal after a proven landing, but is recorded and retried
when convergence encounters the now-absent path instead of falsely reporting successful cleanup.
*/
async function clearWorktreePointer(
  input: CleanupLandedTaskWorktreeInput,
  worktreePath: string,
): Promise<boolean> {
  input.fence?.assertOwned("finalization");
  try {
    await input.store.updateTask(input.taskId, { worktree: null });
    return true;
  } catch (error) {
    await recordPointerClearPending(input, worktreePath, error);
    return false;
  }
}

/**
 * FNXC:WorktreeCleanup 2026-08-29-00:54:
 * FN-251 makes cleanup a proof-gated, non-fatal pre-completion action. A durable landing may discard
 * only ignored-only content; deliverable, unverifiable, and active-session worktrees stay intact and
 * are recorded so completion never retries or misreports an already-landed merge as a failure.
 */
export async function cleanupLandedTaskWorktree(
  input: CleanupLandedTaskWorktreeInput,
): Promise<CleanupLandedTaskWorktreeResult> {
  const worktreePath = input.worktreePath;
  if (!worktreePath || !input.rootDir) {
    return { outcome: "nothing-to-remove", removed: false };
  }
  if (!existsSync(worktreePath)) {
    await clearWorktreePointer(input, worktreePath);
    return { outcome: "nothing-to-remove", removed: false };
  }

  let settings = {};
  try {
    if (typeof input.store.getSettings === "function") {
      settings = await input.store.getSettings();
    }
  } catch (error) {
    const result = preservedOutcomeFor(new Error(`preserving ${worktreePath}: status probe failed (${error instanceof Error ? error.message : String(error)})`));
    await recordPreservedOutcome(input, worktreePath, result);
    return { ...result, removed: false };
  }

  let removal: Awaited<ReturnType<typeof removeWorktree>>;
  try {
    removal = await removeWorktree({
      rootDir: input.rootDir,
      worktreePath,
      settings,
      taskId: input.taskId,
      audit: input.audit,
      reason: RemovalReason.CompletionLandedCleanup,
      postLandingProof: { landedSha: input.landedSha, source: input.source },
    });
  } catch (error) {
    const result = preservedOutcomeFor(error);
    await recordPreservedOutcome(input, worktreePath, result);
    return { ...result, removed: false };
  }

  if (!removal.removed) {
    return { outcome: "nothing-to-remove", removed: false };
  }

  if (!await clearWorktreePointer(input, worktreePath)) {
    return { outcome: "nothing-to-remove", removed: false };
  }
  return { outcome: "removed", removed: true };
}

export interface CleanupLandedWorkspaceTaskWorktreesInput {
  store: LandedWorktreeCleanupStore;
  task: Pick<Task, "id" | "workspaceWorktrees">;
  workspaceRootDir: string;
  landedShas?: Record<string, string | undefined>;
  source: string;
  audit?: RunAuditor;
  log?: (message: string) => void | Promise<void>;
  fence?: Pick<MergeWriteFence, "assertOwned">;
}

export interface WorkspaceLandedWorktreePreservation {
  repoRel: string;
  worktreePath: string;
  outcome: Extract<LandedWorktreeCleanupOutcome, "preserved-deliverable" | "preserved-unverifiable" | "preserved-active-session">;
  reason: string;
}

export interface CleanupLandedWorkspaceTaskWorktreesResult {
  removedRepoRels: string[];
  preserved: WorkspaceLandedWorktreePreservation[];
  taskDirectoryRemoved: boolean;
  removed: boolean;
}

type WorkspacePathOutcome =
  | { kind: "settled"; removed: boolean }
  | { kind: "preserved"; outcome: WorkspaceLandedWorktreePreservation["outcome"]; reason: string };

/*
FNXC:WorktreeCleanup 2026-08-30-15:06:
Workspace post-landing cleanup applies the same proof-gated removal as singular finalization.
Recorded child paths stay durable after removal because the terminal workspace sweep still needs
those paths to delete the matching task branches; only empty directory shells are retired here.
*/
export async function cleanupLandedWorkspaceTaskWorktrees(
  input: CleanupLandedWorkspaceTaskWorktreesInput,
): Promise<CleanupLandedWorkspaceTaskWorktreesResult> {
  const entries = Object.entries(input.task.workspaceWorktrees ?? {})
    .filter(([, entry]) => Boolean(entry.worktreePath));
  const result: CleanupLandedWorkspaceTaskWorktreesResult = {
    removedRepoRels: [],
    preserved: [],
    taskDirectoryRemoved: false,
    removed: false,
  };
  const logInput = { ...input, taskId: input.task.id };
  if (entries.length === 0) return result;

  let settings: Settings = {} as Settings;
  try {
    if (typeof input.store.getSettings === "function") settings = await input.store.getSettings();
  } catch (error) {
    for (const [repoRel, entry] of entries) {
      const worktreePath = entry.worktreePath;
      const preserved = preservedOutcomeFor(new Error(`preserving ${worktreePath}: status probe failed (${error instanceof Error ? error.message : String(error)})`));
      await recordPreservedOutcome(logInput, worktreePath, preserved);
      result.preserved.push({ repoRel, worktreePath, outcome: preserved.outcome as WorkspaceLandedWorktreePreservation["outcome"], reason: preserved.preservedReason ?? "unverifiable" });
    }
    return result;
  }

  const outcomes = new Map<string, WorkspacePathOutcome>();
  for (const [, entry] of entries) {
    const worktreePath = entry.worktreePath;
    const key = canonicalizePath(worktreePath);
    if (outcomes.has(key)) continue;

    if (!existsSync(worktreePath)) {
      outcomes.set(key, { kind: "settled", removed: false });
      continue;
    }
    if (activeSessionRegistry.isPathActive(worktreePath) || activeSessionRegistry.isPathActive(key)) {
      const preservation: WorkspacePathOutcome = { kind: "preserved", outcome: "preserved-active-session", reason: "active-session" };
      outcomes.set(key, preservation);
      await recordPreservedOutcome(logInput, worktreePath, { outcome: preservation.outcome, preservedReason: preservation.reason });
      continue;
    }

    try {
      input.fence?.assertOwned("finalization");
      const removal = await removeWorktree({
        rootDir: join(input.workspaceRootDir, entries.find(([, candidate]) => canonicalizePath(candidate.worktreePath) === key)?.[0] ?? ""),
        worktreePath,
        settings,
        taskId: input.task.id,
        audit: input.audit,
        reason: RemovalReason.CompletionLandedCleanup,
        postLandingProof: {
          landedSha: input.landedShas?.[entries.find(([, candidate]) => canonicalizePath(candidate.worktreePath) === key)?.[0] ?? ""],
          source: input.source,
        },
      });
      outcomes.set(key, { kind: "settled", removed: removal.removed });
    } catch (error) {
      const preserved = preservedOutcomeFor(error);
      const preservation: WorkspacePathOutcome = {
        kind: "preserved",
        outcome: preserved.outcome as WorkspaceLandedWorktreePreservation["outcome"],
        reason: preserved.preservedReason ?? "deliverable",
      };
      outcomes.set(key, preservation);
      await recordPreservedOutcome(logInput, worktreePath, preserved);
    }
  }

  let everyEntrySettled = true;
  for (const [repoRel, entry] of entries) {
    const pathOutcome = outcomes.get(canonicalizePath(entry.worktreePath))!;
    if (pathOutcome.kind === "preserved") {
      everyEntrySettled = false;
      result.preserved.push({ repoRel, worktreePath: entry.worktreePath, outcome: pathOutcome.outcome, reason: pathOutcome.reason });
    } else if (pathOutcome.removed) {
      result.removedRepoRels.push(repoRel);
    }
  }
  result.removed = result.removedRepoRels.length > 0;

  const taskDir = resolveWorkspaceTaskWorktreeDir(input.workspaceRootDir, settings, input.task.id);
  if (!everyEntrySettled || isLegacyWorkspaceWorktreeLayout(input.task, taskDir)) return result;

  result.taskDirectoryRemoved = removeEmptyWorkspaceTaskDirectory(taskDir, entries.map(([, entry]) => entry.worktreePath));
  result.removed = result.removed || result.taskDirectoryRemoved;
  return result;
}

/**
 * Removes only empty workspace task-directory shells. Any unexpected residue
 * fails closed because neither the parents nor the task directory are removed
 * recursively.
 */
export function removeEmptyWorkspaceTaskDirectory(taskDir: string, worktreePaths: string[]): boolean {
  for (const worktreePath of worktreePaths) {
    let parent = dirname(worktreePath);
    while (isStrictDescendantPath(taskDir, parent)) {
      try {
        rmdirSync(parent);
      } catch {
        break;
      }
      parent = dirname(parent);
    }
  }
  try {
    rmdirSync(taskDir);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  }
}
