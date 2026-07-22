import { describe, expect, it, vi } from "vitest";
import { AutoRecoveryDispatcher } from "../../healing/auto-recovery.js";
import { BranchWorktreeAutoRecoveryHandler } from "../../auto-recovery-handlers/branch-worktree.js";

const branchConflictMocks = vi.hoisted(() => ({
  inspectBranchConflict: vi.fn(),
  classifyBootstrapMisbinding: vi.fn(),
  reanchorBranchToBase: vi.fn(),
}));

vi.mock("../../execution/branch-conflicts.js", () => ({
  inspectBranchConflict: branchConflictMocks.inspectBranchConflict,
  classifyBootstrapMisbinding: branchConflictMocks.classifyBootstrapMisbinding,
  reanchorBranchToBase: branchConflictMocks.reanchorBranchToBase,
}));

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4519",
    lineageId: "L1",
    column: "in-progress",
    branch: "fusion/fn-4519",
    worktree: "/tmp/wt",
    baseCommitSha: "main",
    paused: true,
    pausedReason: "branch-conflict-unrecoverable",
    userPaused: false,
    recoveryRetryCount: 0,
    ...overrides,
  } as any;
}

describe("reliability interaction: branch/worktree auto-recovery", () => {
  it("dispatcher delegates to handler for FN-4519 path and requeues", async () => {
    const t = task();
    const taskStore = {
      updateTask: vi.fn(async () => undefined),
      moveTask: vi.fn(async () => undefined),
    } as any;
    const audit = { database: vi.fn(async () => undefined), git: vi.fn(), filesystem: vi.fn() } as any;
    const handler = new BranchWorktreeAutoRecoveryHandler({ taskStore, runAudit: audit });
    const dispatcher = new AutoRecoveryDispatcher({
      taskStore,
      auditEmitter: audit,
      handlers: { issueRetry: (f, d, c) => handler.issueRetry(f, d, c) },
    });

    branchConflictMocks.inspectBranchConflict.mockResolvedValue({ kind: "fully-subsumed", livePath: "/tmp/wt", tipSha: "abc" });

    const decision = await dispatcher.dispatch({
      class: "branch-conflict-unrecoverable",
      taskId: t.id,
      pausedReason: "branch-conflict-unrecoverable",
      evidence: { branchName: t.branch, conflictingWorktreePath: t.worktree },
    }, {
      task: t,
      retryCount: 0,
      settings: { mode: "programmatic", maxRetries: 3 },
    });

    expect(decision.action).toBe("retry");
    expect(taskStore.updateTask).toHaveBeenCalledWith(t.id, { branch: null, baseCommitSha: null });
    expect(taskStore.moveTask).toHaveBeenCalledWith(t.id, "todo", expect.objectContaining({ moveSource: "engine" }));
    expect(audit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "branch-worktree:auto-requeue" }));
  });

  it("preserves userPaused contract", async () => {
    const t = task({ userPaused: true });
    const taskStore = { updateTask: vi.fn(async () => undefined), moveTask: vi.fn(async () => undefined) } as any;
    const audit = { database: vi.fn(async () => undefined), git: vi.fn(), filesystem: vi.fn() } as any;
    const handler = new BranchWorktreeAutoRecoveryHandler({ taskStore, runAudit: audit, logger: { warn: vi.fn(), log: vi.fn(), error: vi.fn() } as any });

    await handler.issueRetry(
      { class: "branch-conflict-unrecoverable", taskId: t.id, pausedReason: "branch-conflict-unrecoverable", evidence: { branchName: t.branch, conflictingWorktreePath: t.worktree } },
      { action: "retry", rationale: "mode-programmatic", legacyPausedReason: "branch-conflict-unrecoverable", auditMetadata: { mode: "programmatic" } },
      { task: t, retryCount: 0, settings: { mode: "programmatic", maxRetries: 3 } as any },
    );

    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(audit.database).not.toHaveBeenCalled();
  });
});
