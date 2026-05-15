import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { AutoRecoveryDispatcher } from "../auto-recovery.js";
import { ContaminationAutoRecoveryHandler } from "../auto-recovery-handlers/contamination.js";

const baseTask = { id: "FN-1", column: "in-progress", recoveryRetryCount: 0 } as Task;

describe("ContaminationAutoRecoveryHandler", () => {
  it("skips when userPaused", async () => {
    const taskStore = { moveTask: vi.fn(), updateTask: vi.fn() } as any;
    const runAudit = { database: vi.fn(), git: vi.fn(), filesystem: vi.fn() } as any;
    const handler = new ContaminationAutoRecoveryHandler({ taskStore, runAudit, repoDir: process.cwd() });
    await handler.issueRetry({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination" }, { action: "retry", rationale: "mode-programmatic", auditMetadata: {}, legacyPausedReason: "x" }, { task: { ...baseTask, userPaused: true } as Task, retryCount: 0, settings: { mode: "programmatic", maxRetries: 3 } });
    expect(taskStore.moveTask).not.toHaveBeenCalled();
  });

  it("requeues and clears paused state", async () => {
    const taskStore = { moveTask: vi.fn(), updateTask: vi.fn() } as any;
    const runAudit = { database: vi.fn(), git: vi.fn(), filesystem: vi.fn() } as any;
    const handler = new ContaminationAutoRecoveryHandler({ taskStore, runAudit, repoDir: process.cwd() });
    await handler.issueRetry({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination", evidence: { ownCommits: 0, foreignAttributedCommits: 2 } }, { action: "retry", rationale: "mode-programmatic", auditMetadata: {}, legacyPausedReason: "x" }, { task: { ...baseTask } as Task, retryCount: 1, settings: { mode: "programmatic", maxRetries: 3 } });
    expect(taskStore.moveTask).toHaveBeenCalledWith("FN-1", "todo", expect.objectContaining({ preserveWorktree: true }));
    expect(taskStore.updateTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({ paused: false, pausedReason: null, error: null }));
    expect(runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "contamination:retry-issued" }));
  });

  it("emits irreducible pause and skips retry for destructive ambiguity", async () => {
    const taskStore = { moveTask: vi.fn(), updateTask: vi.fn() } as any;
    const runAudit = { database: vi.fn(), git: vi.fn(), filesystem: vi.fn() } as any;
    const handler = new ContaminationAutoRecoveryHandler({ taskStore, runAudit, repoDir: process.cwd() });
    await handler.issueRetry({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination", evidence: { ownCommits: 1, foreignAttributedCommits: 1 } }, { action: "retry", rationale: "mode-programmatic", auditMetadata: {}, legacyPausedReason: "x" }, { task: { ...baseTask } as Task, retryCount: 1, settings: { mode: "programmatic", maxRetries: 3 } });
    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "contamination:irreducible-pause" }));
  });

  it("emits irreducible pause and skips retry when retry budget exhausted", async () => {
    const taskStore = { moveTask: vi.fn(), updateTask: vi.fn() } as any;
    const runAudit = { database: vi.fn(), git: vi.fn(), filesystem: vi.fn() } as any;
    const handler = new ContaminationAutoRecoveryHandler({ taskStore, runAudit, repoDir: process.cwd() });
    await handler.issueRetry({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination", evidence: { ownCommits: 0, foreignAttributedCommits: 2 } }, { action: "retry", rationale: "mode-programmatic", auditMetadata: {}, legacyPausedReason: "x" }, { task: { ...baseTask } as Task, retryCount: 3, settings: { mode: "programmatic", maxRetries: 3 } });
    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "contamination:irreducible-pause" }));
  });

  it("mode off does not call handler", async () => {
    const issueRetry = vi.fn();
    const dispatcher = new AutoRecoveryDispatcher({ taskStore: {} as any, auditEmitter: { database: vi.fn(), git: vi.fn(), filesystem: vi.fn() }, handlers: { issueRetry } });
    const decision = await dispatcher.dispatch({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination" }, { task: baseTask, retryCount: 0, settings: { mode: "off", maxRetries: 3 } });
    expect(decision.action).toBe("pause");
    expect(issueRetry).not.toHaveBeenCalled();
  });
});
