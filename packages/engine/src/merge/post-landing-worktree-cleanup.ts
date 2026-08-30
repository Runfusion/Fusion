import { existsSync } from "node:fs";
import type { TaskStore } from "@fusion/core";
import type { RunAuditor } from "../util/run-audit.js";
import {
  ActiveSessionWorktreeRemovalError,
  RemovalReason,
  removeWorktree,
} from "../worktree/worktree-backend.js";
import type { MergeWriteFence } from "./merge-write-fence.js";

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
  input: CleanupLandedTaskWorktreeInput,
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
