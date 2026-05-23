import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoRecoveryContext, AutoRecoveryDecision, AutoRecoveryFailure } from "../auto-recovery.js";
import { BranchWorktreeAutoRecoveryHandler } from "../auto-recovery-handlers/branch-worktree.js";

const branchConflictMocks = vi.hoisted(() => ({
  inspectBranchConflict: vi.fn(),
  classifyBootstrapMisbinding: vi.fn(),
  reanchorBranchToBase: vi.fn(),
}));

vi.mock("../branch-conflicts.js", () => ({
  inspectBranchConflict: branchConflictMocks.inspectBranchConflict,
  classifyBootstrapMisbinding: branchConflictMocks.classifyBootstrapMisbinding,
  reanchorBranchToBase: branchConflictMocks.reanchorBranchToBase,
}));

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4536",
    column: "in-progress",
    branch: "fusion/fn-4536",
    worktree: "/tmp/wt",
    baseCommitSha: "main",
    pausedReason: null,
    userPaused: false,
    ...overrides,
  } as any;
}

function createFixtures(taskOverrides: Record<string, unknown> = {}, mode = "programmatic") {
  const task = createTask(taskOverrides);
  const taskStore = {
    updateTask: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
  } as any;
  const runAudit = { database: vi.fn(async () => undefined), git: vi.fn(), filesystem: vi.fn() } as any;
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() } as any;
  const spawnAiRecoverySession = vi.fn(async () => ({ outcome: "exhausted" as const }));
  const handler = new BranchWorktreeAutoRecoveryHandler({ taskStore, runAudit, logger, spawnAiRecoverySession });
  const failure: AutoRecoveryFailure = { class: "branch-conflict-unrecoverable", taskId: task.id, pausedReason: "branch-conflict-unrecoverable", evidence: {} };
  const decision: AutoRecoveryDecision = { action: "retry", rationale: "mode", legacyPausedReason: "branch-conflict-unrecoverable", auditMetadata: { mode } };
  const ctx: AutoRecoveryContext = { task, retryCount: 0, settings: { mode: "programmatic", maxRetries: 3 } as any };
  return { taskStore, runAudit, logger, spawnAiRecoverySession, handler, failure, decision, ctx };
}

describe("BranchWorktreeAutoRecoveryHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requeues on fully-subsumed", async () => {
    const f = createFixtures();
    branchConflictMocks.inspectBranchConflict.mockResolvedValue({ kind: "fully-subsumed", livePath: "/tmp/wt", tipSha: "abc" });
    await f.handler.issueRetry(f.failure, f.decision, f.ctx);
    expect(f.taskStore.updateTask).toHaveBeenCalledWith("FN-4536", { branch: null, baseCommitSha: null });
    expect(f.taskStore.moveTask).toHaveBeenCalledWith("FN-4536", "todo", expect.objectContaining({ moveSource: "engine", preserveWorktree: false }));
    expect(f.runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "branch-worktree:auto-requeue" }));
  });

  it("reanchors bootstrap misbinding then requeues", async () => {
    const f = createFixtures();
    branchConflictMocks.inspectBranchConflict.mockResolvedValue({ kind: "reclaimable", livePath: "/tmp/wt", tipSha: "abc", taskAttributedCommitCount: 0, strandedCommits: [] });
    branchConflictMocks.classifyBootstrapMisbinding.mockResolvedValue({ isBootstrapMisbinding: true, ownCommitCount: 0, foreignCommitCount: 2, nonAttributedCount: 0 });
    branchConflictMocks.reanchorBranchToBase.mockResolvedValue({});
    await f.handler.issueRetry(f.failure, f.decision, f.ctx);
    expect(branchConflictMocks.reanchorBranchToBase).toHaveBeenCalledTimes(1);
    expect(f.taskStore.moveTask).toHaveBeenCalledWith("FN-4536", "todo", expect.objectContaining({ moveSource: "engine" }));
    expect(f.runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "branch-worktree:auto-requeue", metadata: expect.objectContaining({ rationale: "bootstrap-misbinding-reanchor" }) }));

    // Regression: prior to the fix, the handler passed `foreignCommits: []`
    // to classifyBootstrapMisbinding, which silently disabled the predicate
    // (foreignCommits.length > 0 was always false) and turned this entire
    // branch into dead code for the FN-5475-class misbinding.
    const classifyCall = branchConflictMocks.classifyBootstrapMisbinding.mock.calls[0][0];
    expect(classifyCall.foreignCommits).toBeUndefined();
  });

  it("unparks stale paused conflict", async () => {
    const f = createFixtures({ paused: true, pausedReason: "branch-conflict-unrecoverable" });
    branchConflictMocks.inspectBranchConflict.mockResolvedValue({ kind: "stale-resolved" });
    await f.handler.issueRetry(f.failure, f.decision, f.ctx);
    expect(f.taskStore.moveTask).toHaveBeenCalled();
    expect(f.runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "branch-worktree:auto-requeue", metadata: expect.objectContaining({ prevPausedReason: "branch-conflict-unrecoverable" }) }));
  });

  it("live-foreign discards branch claim and requeues", async () => {
    const f = createFixtures();
    branchConflictMocks.inspectBranchConflict.mockResolvedValue({
      kind: "live-foreign",
      livePath: "/tmp/wt",
      error: { strandedCommits: [] },
    });
    await f.handler.issueRetry(f.failure, f.decision, f.ctx);
    expect(f.taskStore.moveTask).toHaveBeenCalledWith("FN-4536", "todo", expect.objectContaining({ moveSource: "engine" }));
    expect(f.runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "branch-worktree:foreign-branch-discarded" }));
    expect(f.runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "branch-worktree:auto-requeue", metadata: expect.objectContaining({ rationale: "live-foreign-discard-and-recreate" }) }));
  });

  it("ai-assisted exhaustion logs spawned and irreducible", async () => {
    const f = createFixtures({}, "ai-assisted");
    await f.handler.spawnAiRecovery(f.failure, { ...f.decision, auditMetadata: { mode: "ai-assisted" } }, f.ctx);
    expect(f.spawnAiRecoverySession).toHaveBeenCalledTimes(1);
    expect(f.runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "branch-worktree:ai-session-spawned", metadata: expect.objectContaining({ outcome: "exhausted" }) }));
    expect(f.runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "branch-worktree:irreducible-pause", metadata: expect.objectContaining({ reason: "ai-session-unresolved" }) }));
  });

  it("mode off is no-op", async () => {
    const f = createFixtures({}, "off");
    await f.handler.issueRetry(f.failure, { ...f.decision, auditMetadata: { mode: "off" } }, f.ctx);
    expect(f.taskStore.moveTask).not.toHaveBeenCalled();
    expect(f.runAudit.database).not.toHaveBeenCalled();
  });

  it("userPaused skips", async () => {
    const f = createFixtures({ userPaused: true, pausedReason: "branch-conflict-unrecoverable", paused: true });
    await f.handler.issueRetry(f.failure, f.decision, f.ctx);
    expect(f.taskStore.moveTask).not.toHaveBeenCalled();
    expect(f.runAudit.database).not.toHaveBeenCalled();
    expect(f.logger.warn).toHaveBeenCalledWith(expect.stringContaining("skipped (userPaused)"));
  });
});
