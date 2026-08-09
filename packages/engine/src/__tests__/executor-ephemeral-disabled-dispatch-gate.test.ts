import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  AgentSemaphore,
  clearPreHeldExecutorSlotsForTests,
  hasPreHeldExecutorSlot,
  registerPreHeldExecutorSlot,
} from "../concurrency/concurrency.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

const now = "2026-08-07T00:00:00.000Z";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-8821-EXECUTOR",
    title: "Executor compatibility regression",
    description: "Dispatch through the workflow graph",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    status: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    mergeRetries: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

function settings() {
  return {
    autoMerge: true,
    maxAutoMergeRetries: 3,
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15_000,
  };
}

/*
FNXC:WorkflowAgentRouting 2026-08-09-01:04:
FN-8847 removes the retired compatibility input. Every TaskExecutor.execute() entry must use graph
admission for durable principal acquisition, unavailable-principal holds, and capacity fencing.
*/
const graphDefinition = {
  id: "WF-fn-8821-principal",
  name: "FN-8821 principal fixture",
  ir: {
    version: "v1",
    name: "FN-8821 principal fixture",
    nodes: [
      { id: "start", kind: "start" },
      { id: "execute", kind: "script", config: { seam: "execute", scriptName: "noop" } },
      { id: "end", kind: "end" },
    ],
    edges: [{ from: "start", to: "execute" }, { from: "execute", to: "end" }],
  },
};

function durableExecutorAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "workflow-executor",
    name: "Workflow Executor",
    state: "active",
    roles: ["executor"],
    createdAt: now,
    runtimeConfig: {},
    ...overrides,
  };
}

function createProductionGraphHarness(
  agents: unknown[] = [durableExecutorAgent()],
  taskOverrides: Partial<TaskDetail> = {},
  semaphore?: AgentSemaphore,
) {
  const store = createMockStore();
  const live = task(taskOverrides);
  store.getTask.mockResolvedValue(live);
  store.getRootDir = vi.fn(() => "/tmp/fn-8821-project");
  store.getSettings.mockResolvedValue(settings());
  store.getTaskWorkflowSelectionAsync.mockResolvedValue({ workflowId: graphDefinition.id, stepIds: [] });
  store.getTaskWorkflowSelection.mockReturnValue({ workflowId: graphDefinition.id, stepIds: [] });
  store.getWorkflowDefinition = vi.fn(async () => graphDefinition);
  store.upsertWorkflowWorkItem = vi.fn(async (input: Record<string, unknown>) => ({ id: "work-item-1", ...input }));
  const agentStore = {
    workflowProjectId: "project-fn-8821",
    listAgents: vi.fn(async () => agents),
  };
  const executor = new TaskExecutor(store, "/tmp/fn-8821-executor", { agentStore, semaphore } as any);
  const acquire = vi.spyOn((executor as any).workflowAgentCapacity, "acquire").mockResolvedValue({ status: "acquired" });
  const release = vi.spyOn((executor as any).workflowAgentCapacity, "release").mockResolvedValue(undefined);
  return { store, live, executor, agentStore, acquire, release };
}

describe("executor routes workflow stages through durable principals", () => {
  afterEach(() => {
    clearPreHeldExecutorSlotsForTests();
    (TaskExecutor as unknown as { processWideGraphRouting: Set<string> }).processWideGraphRouting.clear();
  });

  it("runs real graph principal admission for unassigned direct re-entry", async () => {
      resetExecutorMocks();
      const { store, live, executor, agentStore, acquire, release } = createProductionGraphHarness();

      await executor.execute(live);

      expect(agentStore.listAgents).toHaveBeenCalledWith({ includeEphemeral: true });
      expect(store.upsertWorkflowWorkItem).toHaveBeenCalled();
      expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-fn-8821",
        agent: expect.objectContaining({ id: "workflow-executor" }),
        maxProjectSessions: 2,
      }));
      expect(release).toHaveBeenCalledOnce();
      expect((TaskExecutor as unknown as { processWideGraphRouting: Set<string> }).processWideGraphRouting).not.toContain(live.id);
      expect(store.upsertWorkflowWorkItem).toHaveBeenCalledWith(expect.objectContaining({
        state: "running",
        principalAgentId: "workflow-executor",
        workflowRole: "executor",
        authorityKind: "role-pool",
      }));
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalledWith(live.id, expect.objectContaining({ status: "queued" }), undefined);
      expect(store.logEntry).not.toHaveBeenCalledWith(
        live.id,
        expect.stringContaining("ephemeral agents disabled"),
        expect.anything(),
        expect.anything(),
      );
  });

  it("preserves assigned workflow principals through scheduler-held graph dispatch", async () => {
      resetExecutorMocks();
      const semaphore = new AgentSemaphore(1);
      expect(semaphore.tryAcquire()).toBe(true);
      const { store, live, executor, acquire, release } = createProductionGraphHarness(
        [durableExecutorAgent()],
        { assignedAgentId: "workflow-executor" },
        semaphore,
      );
      registerPreHeldExecutorSlot(live.id);

      await executor.execute(live);

      expect(store.upsertWorkflowWorkItem).toHaveBeenCalledWith(expect.objectContaining({
        state: "running",
        principalAgentId: "workflow-executor",
        workflowRole: "executor",
        authorityKind: "task-assignee",
      }));
      expect(acquire).toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(acquire.mock.calls.length);
      expect(hasPreHeldExecutorSlot(live.id)).toBe(false);
      expect(semaphore.activeCount).toBe(0);
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });

  it("keeps direct re-entry behind the real unmet-dependency gate", async () => {
    resetExecutorMocks();
    const { store, live, executor, agentStore, acquire } = createProductionGraphHarness(
      [durableExecutorAgent()],
      { dependencies: ["FN-8821-PARENT"] },
    );
    const parent = task({
      id: "FN-8821-PARENT",
      dependencies: [],
      column: "in-progress",
    });
    store.listTasks.mockResolvedValue([live, parent]);

    await executor.execute(live);

    expect(agentStore.listAgents).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(store.transitionQueuedEpisode).toHaveBeenCalledWith(live.id, expect.objectContaining({
      signature: "dependency:FN-8821-PARENT",
      blockedBy: parent.id,
    }));
    expect(store.upsertWorkflowWorkItem).not.toHaveBeenCalled();
  });

  it("holds unavailable workflow principals through their graph owner", async () => {
      resetExecutorMocks();
      const { store, live, executor, agentStore, acquire } = createProductionGraphHarness([]);

      await executor.execute(live);

      expect(agentStore.listAgents).toHaveBeenCalledOnce();
      expect(acquire).not.toHaveBeenCalled();
      expect(store.upsertWorkflowWorkItem).toHaveBeenCalledWith(expect.objectContaining({
        state: "held",
        blockedReason: "workflow-principal-role-pool-exhausted:executor",
        workflowRole: "executor",
        authorityKind: null,
      }));
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });

  it("holds saturated workflow principals through graph capacity", async () => {
      resetExecutorMocks();
      const { store, live, executor, acquire } = createProductionGraphHarness();
      acquire.mockResolvedValue({ status: "held", reason: "project-capacity" });

      await executor.execute(live);

      expect(acquire).toHaveBeenCalledOnce();
      expect(store.upsertWorkflowWorkItem).toHaveBeenCalledWith(expect.objectContaining({
        state: "held",
        blockedReason: "workflow-principal-project-capacity:executor",
        principalAgentId: "workflow-executor",
        authorityKind: "role-pool",
      }));
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });
});
