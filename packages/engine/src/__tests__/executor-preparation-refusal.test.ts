import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks, mockedCreateFnAgent, mockedStepSessionExecutor } from "./executor-test-helpers.js";
import * as worktreeAcquisition from "../worktree/worktree-acquisition.js";

function singleSessionTask(overrides: Record<string, unknown> = {}) {
  return { id: "FN-001", title: "Preparation", description: "Preparation", column: "in-progress",
    dependencies: [], steps: [{ name: "Preflight", status: "in-progress" }], currentStep: 0,
    log: [], prompt: "# Preparation", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides };
}
function makeAssignedAgent() {
  return { id: "agent-Y", name: "Executor", runtimeConfig: { model: "openai/gpt-assigned" } };
}
function makeExecutor(store: ReturnType<typeof createMockStore>, agents: Record<string, unknown>) {
  return { executor: new TaskExecutor(store as never, "/tmp/test", { agentStore: { getAgent: vi.fn(async (id: string) => agents[id] ?? null) } } as any) };
}

describe("implementation preparation refusal", () => {
  beforeEach(() => resetExecutorMocks());
  /* FNXC:WorktreeBaseRefresh 2026-09-19-20:13: Both session modes must hand a pre-session integrity refusal back to graph recovery, never return an incomplete implementation pass. */
  it.each([false, true])("preserves acquisition refusal through implementation cleanup (step sessions=%s)", async (stepSessions) => {
    const store = createMockStore();
    const task = singleSessionTask({ assignedAgentId: "agent-Y" });
    store.getTask.mockResolvedValue(task as any);
    const { executor } = makeExecutor(store, { "agent-Y": makeAssignedAgent() });
    if (stepSessions) (executor as any).graphStepSessionPinned.add(task.id);
    const refusal = new worktreeAcquisition.WorktreeBaseRefreshError({
      kind: "base-reconciliation-required", executionSafe: false, detail: "rebase-merge is owned by another operation",
    });
    const acquire = vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(refusal);
    try {
      await expect((executor as any).runImplementationPhase(task)).rejects.toBe(refusal);
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
      expect(mockedStepSessionExecutor).not.toHaveBeenCalled();
      expect((executor as any).executing.has(task.id)).toBe(false);
      expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("base-reconciliation-required"), refusal.refresh.detail, expect.anything());
    } finally {
      acquire.mockRestore();
    }
  });

});
