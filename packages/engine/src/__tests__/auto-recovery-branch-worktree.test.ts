import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoRecoveryContext, AutoRecoveryDecision, AutoRecoveryFailure } from "../auto-recovery.js";
import { BranchWorktreeAutoRecoveryHandler } from "../auto-recovery-handlers/branch-worktree.js";
import { RENAMED_VOCAB, lifecycleIr } from "./_workflow-vocabulary-fixture.js";
import { TransitionRejectionError } from "@fusion/core";

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

/*
FNXC:WorkflowResolvedColumns 2026-07-30-13:50 (batch-engine tail):
`ir` is optional so every existing case is byte-identical: with no workflow the resolver degrades to the
built-in coding IR, whose wip lane is `in-progress` and whose rebound target is `todo` — exactly what
those cases already assert.
*/
function createFixtures(taskOverrides: Record<string, unknown> = {}, mode = "programmatic", ir?: unknown) {
  const task = createTask(taskOverrides);
  const taskStore = {
    updateTask: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    ...(ir
      ? {
          getTaskWorkflowSelectionAsync: async () => ({ workflowId: "recovery-lifecycle", stepIds: [] }),
          getTaskWorkflowSelection: () => ({ workflowId: "recovery-lifecycle", stepIds: [] }),
          getWorkflowDefinition: async (id: string) => (id === "recovery-lifecycle" ? { ir } : undefined),
        }
      : {}),
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

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-13:50 (batch-engine tail):
  TWO defects, one case. The requeue destination was the hardcoded `todo` — CENSUS-INVISIBLE, because
  the census scores comparisons and that is a call argument — so a board with no `todo` column was
  requeued into a lane that does not exist. And the WIP test was the id `in-progress`, so the stale
  branch/baseCommitSha were never cleared and the card carried a dead branch back into execution.

  REVERT CHECK, measured (both, independently):
    - `moveTask(..., "todo", ...)` restored -> this fails; moveTask is called with "todo", not "backlog".
    - `task.column === "in-progress"` restored -> this fails; updateTask is never called.
  The legacy cases pass both ways, which is why they are kept alongside.
  */
  it("requeues to the RESOLVED rebound target and clears the branch on a RENAMED board", async () => {
    const f = createFixtures(
      { column: RENAMED_VOCAB.wip },
      "programmatic",
      lifecycleIr(RENAMED_VOCAB, "recovery-lifecycle"),
    );
    branchConflictMocks.inspectBranchConflict.mockResolvedValue({ kind: "fully-subsumed", livePath: "/tmp/wt", tipSha: "abc" });

    await f.handler.issueRetry(f.failure, f.decision, f.ctx);

    expect(f.taskStore.updateTask).toHaveBeenCalledWith("FN-4536", { branch: null, baseCommitSha: null });
    expect(f.taskStore.moveTask).toHaveBeenCalledWith(
      "FN-4536",
      RENAMED_VOCAB.hold,
      expect.objectContaining({ moveSource: "engine", preserveWorktree: false }),
    );
    expect(f.taskStore.moveTask).not.toHaveBeenCalledWith("FN-4536", "todo", expect.anything());
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-13:45 (#2797 review — greptile):

  THE REQUEUE MUST NOT DIE ON A DESTINATION THE BOARD DOES NOT DECLARE.

  The review pointed at the `catch` retaining `reboundTarget = "todo"`. Writing the test for that
  branch DISPROVED it as the main route: `resolveWorkflowIrForTask` degrades to the BUILT-IN IR rather
  than throwing, so a task whose custom workflow cannot be read still resolves `todo` from the DEFAULT
  board and the catch never runs. A guard on the throw path alone would have passed review and fixed
  almost nothing.

  What actually bites is the move. `moveTaskInternal` REJECTS a column the workflow does not declare,
  and unhandled that throws out of the recovery handler whose entire job is to unstick the task — so
  the recovery became a second way to stay stuck, with no audit row explaining it.

  This drives the rejection itself, which is the behaviour every route ends at.
  */
  it("records a skip instead of throwing when the rebound destination is rejected", async () => {
    const f = createFixtures({ column: "building" }, "programmatic");
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-17:45 (#2797 review — greptile P1):
    A REAL TransitionRejectionError, not a look-alike Error whose message happens to read like one.
    The reason is now derived from the typed `rejection.code`, so a plain Error must NOT be classified
    as a lane problem — which is the point of the companion case below.
    */
    f.taskStore.moveTask.mockRejectedValue(
      new TransitionRejectionError(
        { code: "unknown-column", messageKey: "transition.rejected.unknownColumn", retryable: false, detail: "Column 'todo' is not defined in this task's workflow" } as never,
        "Invalid transition: 'building' -> 'todo'. Unknown column for this workflow.",
      ),
    );
    branchConflictMocks.inspectBranchConflict.mockResolvedValue({ kind: "fully-subsumed", livePath: "/tmp/wt", tipSha: "abc" });

    /* The handler must not propagate — that is the regression. */
    await expect(f.handler.issueRetry(f.failure, f.decision, f.ctx)).resolves.not.toThrow();

    expect(f.runAudit.database).toHaveBeenCalledWith(expect.objectContaining({
      type: "branch-worktree:auto-requeue-skipped",
      metadata: expect.objectContaining({ reason: "rebound-target-rejected", rejectionCode: "unknown-column", reboundTarget: "todo" }),
    }));
    /* And the success audit must NOT be written for a move that did not happen. */
    expect(f.runAudit.database).not.toHaveBeenCalledWith(expect.objectContaining({ type: "branch-worktree:auto-requeue" }));
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-17:45 (#2797 review — greptile P1 "move failures become
  successful retries"):
  A moveTask failure that is NOT a lane problem — capacity exhaustion, a guard rejection, a deleted
  task, a persistence error — was labelled `rebound-target-rejected` all the same, so the audit row
  asserted a lane cause for something that has nothing to do with lanes and anyone debugging a stuck
  card would chase the wrong thing.

  REVERT CHECK, measured: collapsing the reason back to the single literal makes this fail — the row
  reads `rebound-target-rejected` for a plain persistence error.
  */
  it("names a non-lane move failure honestly instead of blaming the rebound target", async () => {
    const f = createFixtures({ column: "in-progress" }, "programmatic");
    f.taskStore.moveTask.mockRejectedValue(new Error("database connection lost"));
    branchConflictMocks.inspectBranchConflict.mockResolvedValue({ kind: "fully-subsumed", livePath: "/tmp/wt", tipSha: "abc" });

    await expect(f.handler.issueRetry(f.failure, f.decision, f.ctx)).resolves.not.toThrow();

    expect(f.runAudit.database).toHaveBeenCalledWith(expect.objectContaining({
      type: "branch-worktree:auto-requeue-skipped",
      metadata: expect.objectContaining({ reason: "requeue-move-failed" }),
    }));
    expect(f.runAudit.database).not.toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ reason: "rebound-target-rejected" }),
    }));
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-17:45 (#2797 review — greptile P1 "rejected move erases
  branch linkage"):
  The branch/baseCommitSha clear used to run BEFORE the move, so a rejected move left the card in its
  wip lane with the only pointers back to its work already erased — the recovery destroyed the linkage
  and then declined to requeue. Half-applied is worse than not applied; nothing reconstructs the branch
  from the row afterwards.

  REVERT CHECK, measured: moving the clear back above the move makes this fail — updateTask is called
  with { branch: null, baseCommitSha: null } on a move that never landed.
  */
  it("preserves the branch linkage when the requeue move is rejected", async () => {
    const f = createFixtures({ column: "in-progress" }, "programmatic");
    f.taskStore.moveTask.mockRejectedValue(new Error("database connection lost"));
    branchConflictMocks.inspectBranchConflict.mockResolvedValue({ kind: "fully-subsumed", livePath: "/tmp/wt", tipSha: "abc" });

    await f.handler.issueRetry(f.failure, f.decision, f.ctx);

    expect(f.taskStore.updateTask).not.toHaveBeenCalledWith("FN-4536", { branch: null, baseCommitSha: null });
  });

  it("does not clear the branch when a RENAMED board's card is not in its wip lane", async () => {
    /*
    Non-vacuous companion: without it, a guard that cleared unconditionally would pass the case above.
    Same renamed board, same failure — only the card's lane changes.
    */
    const f = createFixtures(
      { column: RENAMED_VOCAB.review },
      "programmatic",
      lifecycleIr(RENAMED_VOCAB, "recovery-lifecycle"),
    );
    branchConflictMocks.inspectBranchConflict.mockResolvedValue({ kind: "fully-subsumed", livePath: "/tmp/wt", tipSha: "abc" });

    await f.handler.issueRetry(f.failure, f.decision, f.ctx);

    expect(f.taskStore.updateTask).not.toHaveBeenCalled();
    expect(f.taskStore.moveTask).toHaveBeenCalledWith("FN-4536", RENAMED_VOCAB.hold, expect.anything());
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
