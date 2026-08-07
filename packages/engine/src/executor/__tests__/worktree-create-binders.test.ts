/**
 * FNXC:CodeOrganization 2026-08-04-02:05:
 * Characterization for bindTryCreateWorktree / bindHandleWorktreeConflict (U4).
 * Default-fills optional allowSibling/settings the same way the former inline
 * façade lambdas did, so multi-site create/conflict wiring cannot drift.
 */
import { describe, expect, it, vi } from "vitest";
import {
  bindHandleWorktreeConflict,
  bindTryCreateWorktree,
} from "../worktree-create-binders.js";
import {
  BRANCH_CONFLICT_TRIPWIRE_THRESHOLD,
  COMPLETED_TASK_WATCHDOG_MS,
  MAX_AUTO_RECOVERY_ATTEMPTS,
  MAX_WORKFLOW_STEP_RETRIES,
  MAX_WORKTREE_RETRIES,
  WORKFLOW_RERUN_WATCHDOG_MS,
  WORKTREE_RETRY_DELAYS,
} from "../executor-constants.js";

describe("worktree-create-binders", () => {
  it("fills allowSiblingBranchRename=false and settings={} when omitted on tryCreate", async () => {
    const tryCreateWorktree = vi.fn(async () => ({ path: "/wt", branch: "fusion/x" }));
    const bound = bindTryCreateWorktree({ tryCreateWorktree });
    await bound("fusion/x", "/wt", "FN-1", "origin/main", 2, 1);
    expect(tryCreateWorktree).toHaveBeenCalledWith(
      "fusion/x",
      "/wt",
      "FN-1",
      "origin/main",
      2,
      1,
      false,
      {},
    );
  });

  it("preserves explicit allowSibling and settings on tryCreate", async () => {
    const tryCreateWorktree = vi.fn(async () => ({ path: "/wt", branch: "fusion/x" }));
    const bound = bindTryCreateWorktree({ tryCreateWorktree });
    const settings = { worktreesDir: "/custom" };
    await bound("fusion/x", "/wt", "FN-1", undefined, 0, 0, true, settings);
    expect(tryCreateWorktree).toHaveBeenCalledWith(
      "fusion/x",
      "/wt",
      "FN-1",
      undefined,
      0,
      0,
      true,
      settings,
    );
  });

  it("fills defaults on handleWorktreeConflict the same way", async () => {
    const handleWorktreeConflict = vi.fn(async () => null);
    const bound = bindHandleWorktreeConflict({ handleWorktreeConflict });
    await bound("/conflict", "fusion/x", "/wt", "FN-1", "main", 1);
    expect(handleWorktreeConflict).toHaveBeenCalledWith(
      "/conflict",
      "fusion/x",
      "/wt",
      "FN-1",
      "main",
      1,
      false,
      {},
    );
  });
});

describe("executor-constants", () => {
  it("keeps the historical tuning values used by TaskExecutor facades", () => {
    expect(MAX_WORKFLOW_STEP_RETRIES).toBe(3);
    expect(COMPLETED_TASK_WATCHDOG_MS).toBe(60_000);
    expect(WORKFLOW_RERUN_WATCHDOG_MS).toBe(15_000);
    expect(MAX_WORKTREE_RETRIES).toBe(3);
    expect([...WORKTREE_RETRY_DELAYS]).toEqual([100, 500, 1000]);
    expect(MAX_AUTO_RECOVERY_ATTEMPTS).toBe(3);
    expect(BRANCH_CONFLICT_TRIPWIRE_THRESHOLD).toBe(5);
  });
});
