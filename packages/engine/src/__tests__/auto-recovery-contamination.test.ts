import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { AutoRecoveryDispatcher } from "../healing/auto-recovery.js";
import { ContaminationAutoRecoveryHandler } from "../auto-recovery-handlers/contamination.js";

vi.mock("../execution/branch-conflicts.js", () => ({
  classifyForeignOnlyContamination: vi.fn(async () => ({ kind: "foreign-only-no-own-work" })),
}));
vi.mock("../recovery/foreign-only-contamination.js", () => ({
  recoverForeignOnlyContamination: vi.fn(async () => ({ recovered: true, subtype: "reanchor" })),
}));

const baseTask = { id: "FN-1", column: "in-progress", recoveryRetryCount: 0 } as Task;

/*
FNXC:LifecycleContainment 2026-08-31-09:28:
One factory rather than five inline literals, because the missing method was the failure: FN-207/
FN-217 containment made the recovery NARRATE when it retains a card in place
(`moveTaskToContainedBackwardTarget` -> `store.logEntry`), and a fake without `logEntry` threw a
TypeError that read as a product fault. Five copies meant five places to forget; one factory means
the next method the path adopts is added once.
*/
function makeTaskStore() {
  return { moveTask: vi.fn(), updateTask: vi.fn(), logEntry: vi.fn(async () => undefined) } as any;
}

describe("ContaminationAutoRecoveryHandler", () => {
  it("skips when userPaused", async () => {
    const taskStore = makeTaskStore();
    const runAudit = { database: vi.fn(), git: vi.fn(), filesystem: vi.fn() } as any;
    const handler = new ContaminationAutoRecoveryHandler({ taskStore, runAudit, repoDir: process.cwd() });
    await handler.issueRetry({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination" }, { action: "retry", rationale: "mode-programmatic", auditMetadata: {}, legacyPausedReason: "x" }, { task: { ...baseTask, userPaused: true } as Task, retryCount: 0, settings: { mode: "programmatic", maxRetries: 3 } });
    expect(taskStore.moveTask).not.toHaveBeenCalled();
  });

  it("requeues and clears paused state", async () => {
    const taskStore = makeTaskStore();
    const runAudit = { database: vi.fn(), git: vi.fn(), filesystem: vi.fn() } as any;
    const handler = new ContaminationAutoRecoveryHandler({ taskStore, runAudit, repoDir: process.cwd() });
    await handler.issueRetry({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination", evidence: { ownCommits: 0, foreignAttributedCommits: 2 } }, { action: "retry", rationale: "mode-programmatic", auditMetadata: {}, legacyPausedReason: "x" }, { task: { ...baseTask } as Task, retryCount: 1, settings: { mode: "programmatic", maxRetries: 3 } });
    /*
    FNXC:LifecycleContainment 2026-08-31-09:28:
    This asserted a backward move to `todo`. FN-207/FN-217 forbids it: only a REVISION may move a
    card backward, and `moveTaskToContainedBackwardTarget` enforces that with a closed allow-list of
    four revision reasons. "contamination-recovery" is deliberately not among them -- the rule names
    contamination recovery as work that "stays in the current lifecycle role".

    So the card is retained and the retention is narrated. The recovery itself is unchanged and still
    proven below: the pause is cleared and the attempt is audited. Asserting the move again would be
    asking for the backward transition the containment rule exists to prevent.
    */
    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(taskStore.logEntry).toHaveBeenCalledWith("FN-1", expect.stringContaining("retained in 'in-progress'"));
    expect(taskStore.updateTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({ paused: false, pausedReason: null, error: null }));
    expect(runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "contamination:retry-issued" }));
  });

  it("uses foreign-only recovery helper when branch/worktree metadata exists", async () => {
    const taskStore = makeTaskStore();
    const runAudit = { database: vi.fn(), git: vi.fn(), filesystem: vi.fn() } as any;
    const handler = new ContaminationAutoRecoveryHandler({ taskStore, runAudit, repoDir: process.cwd() });
    await handler.issueRetry({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination", evidence: { ownCommits: 0, foreignAttributedCommits: 2 } }, { action: "retry", rationale: "mode-programmatic", auditMetadata: {}, legacyPausedReason: "x" }, { task: { ...baseTask, branch: "fusion/fn-1", worktree: "/tmp/fn-1", baseCommitSha: "main" } as Task, retryCount: 1, settings: { mode: "programmatic", maxRetries: 3 } });
    expect(runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "contamination:retry-issued", metadata: expect.objectContaining({ recoveryKind: "foreign-only", subtype: "reanchor" }) }));
  });

  it("emits irreducible pause and skips retry for destructive ambiguity", async () => {
    const taskStore = makeTaskStore();
    const runAudit = { database: vi.fn(), git: vi.fn(), filesystem: vi.fn() } as any;
    const handler = new ContaminationAutoRecoveryHandler({ taskStore, runAudit, repoDir: process.cwd() });
    await handler.issueRetry({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination", evidence: { ownCommits: 1, foreignAttributedCommits: 1 } }, { action: "retry", rationale: "mode-programmatic", auditMetadata: {}, legacyPausedReason: "x" }, { task: { ...baseTask } as Task, retryCount: 1, settings: { mode: "programmatic", maxRetries: 3 } });
    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "contamination:irreducible-pause" }));
  });

  it("emits irreducible pause and skips retry when retry budget exhausted", async () => {
    const taskStore = makeTaskStore();
    const runAudit = { database: vi.fn(), git: vi.fn(), filesystem: vi.fn() } as any;
    const handler = new ContaminationAutoRecoveryHandler({ taskStore, runAudit, repoDir: process.cwd() });
    await handler.issueRetry({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination", evidence: { ownCommits: 0, foreignAttributedCommits: 2 } }, { action: "retry", rationale: "mode-programmatic", auditMetadata: {}, legacyPausedReason: "x" }, { task: { ...baseTask } as Task, retryCount: 3, settings: { mode: "programmatic", maxRetries: 3 } });
    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "contamination:irreducible-pause" }));
  });

  it("mode off does not call handler", async () => {
    const issueRetry = vi.fn();
    const dispatcher = new AutoRecoveryDispatcher({ taskStore: {} as any, auditEmitter: { database: vi.fn(), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() }, handlers: { issueRetry } });
    const decision = await dispatcher.dispatch({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination" }, { task: baseTask, retryCount: 0, settings: { mode: "off", maxRetries: 3 } });
    expect(decision.action).toBe("pause");
    expect(issueRetry).not.toHaveBeenCalled();
  });
});
