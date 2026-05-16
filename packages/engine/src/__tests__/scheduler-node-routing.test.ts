import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeStatus, Task, TaskStore } from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { schedulerLog } from "../logger.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(),
  };
});

vi.mock("../logger.js", () => ({
  schedulerLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-100",
    description: "Node routing task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    prompt: "",
    ...overrides,
  } as Task;
}

function createMockStore(task: Task, settings: Record<string, unknown> = {}): TaskStore {
  return {
    listTasks: vi.fn().mockResolvedValue([task]),
    getSettings: vi.fn().mockResolvedValue(settings),
    getTask: vi.fn().mockResolvedValue(task),
    updateTask: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/tmp/test"),
    getTasksDir: vi.fn().mockReturnValue("/tmp/test/.fusion/tasks"),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function createMockHealthMonitor(statusMap: Record<string, NodeStatus | undefined>) {
  return {
    getNodeHealth: vi.fn((id: string) => statusMap[id]),
  } as unknown as import("../node-health-monitor.js").NodeHealthMonitor;
}

function allowDispatchValidator() {
  return vi.fn().mockResolvedValue({ allowed: true } as const);
}

describe("Scheduler node routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue("# Task\nNode routing");
  });

  it("stores task override as effective node", async () => {
    const task = createMockTask({ id: "FN-101", nodeId: "node-task" });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1, defaultNodeId: "node-project" });
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      effectiveNodeId: "node-task",
      effectiveNodeSource: "task-override",
    }));
    expect(store.logEntry).toHaveBeenCalledWith(task.id, "Node routing resolved: node-task (source: task-override)");
    expect(schedulerLog.log).toHaveBeenCalledWith("Task FN-101 routed to node=node-task (source=task-override)");
  });

  it("uses project default when task nodeId is unset", async () => {
    const task = createMockTask({ id: "FN-102", nodeId: undefined });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1, defaultNodeId: "node-project" });
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      effectiveNodeId: "node-project",
      effectiveNodeSource: "project-default",
    }));
    expect(store.logEntry).toHaveBeenCalledWith(task.id, "Node routing resolved: node-project (source: project-default)");
  });

  it("uses local when neither task nor project default are set", async () => {
    const task = createMockTask({ id: "FN-103", nodeId: undefined });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1 });
    const scheduler = new Scheduler(store, { nodeHealthMonitor: undefined });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      effectiveNodeId: null,
      effectiveNodeSource: "local",
    }));
    expect(store.logEntry).toHaveBeenCalledWith(task.id, "Node routing resolved: local (source: local)");
    expect(schedulerLog.log).toHaveBeenCalledWith("Task FN-103 routed to node=local (source=local)");
  });

  it("accepts nodeHealthMonitor option at construction", () => {
    const task = createMockTask();
    const store = createMockStore(task);

    const scheduler = new Scheduler(store, {
      nodeHealthMonitor: {
        getNodeHealth: vi.fn(),
      } as unknown as import("../node-health-monitor.js").NodeHealthMonitor,
    });

    expect(scheduler).toBeDefined();
  });

  it("dispatches when node mapping validator allows execution", async () => {
    const task = createMockTask({ id: "FN-112", nodeId: "node-mapped" });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1 });
    const validateNodeDispatch = allowDispatchValidator();
    const scheduler = new Scheduler(store, { validateNodeDispatch });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(validateNodeDispatch).toHaveBeenCalledWith("node-mapped");
    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      effectiveNodeId: "node-mapped",
      effectiveNodeSource: "task-override",
    }));
  });

  it("blocks dispatch when node mapping validator fails", async () => {
    const task = createMockTask({ id: "FN-113", nodeId: "node-unmapped" });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1 });
    const validateNodeDispatch = vi.fn().mockResolvedValue({
      allowed: false,
      code: "missing-project-mapping",
      reason: "Execution blocked: project has no path mapping for node node-unmapped",
    } as const);
    const scheduler = new Scheduler(store, { validateNodeDispatch });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      "Execution blocked: project has no path mapping for node node-unmapped",
    );
  });

  it("deduplicates missing-mapping block logs across schedule cycles", async () => {
    const task = createMockTask({ id: "FN-114", nodeId: "node-unmapped" });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1 });
    const validateNodeDispatch = vi.fn().mockResolvedValue({
      allowed: false,
      code: "missing-project-mapping",
      reason: "Execution blocked: project has no path mapping for node node-unmapped",
    } as const);
    const scheduler = new Scheduler(store, { validateNodeDispatch });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();
    await scheduler.schedule();

    const missingMappingLogs = vi.mocked(store.logEntry).mock.calls.filter(([, message]) =>
      String(message).includes("project has no path mapping for node node-unmapped"),
    );
    expect(missingMappingLogs).toHaveLength(1);
  });

  it("clears missing-mapping dedup state after successful dispatch", async () => {
    const task = createMockTask({ id: "FN-115", nodeId: "node-flappy" });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1 });
    const validateNodeDispatch = vi
      .fn()
      .mockResolvedValueOnce({
        allowed: false,
        code: "missing-project-mapping",
        reason: "Execution blocked: project has no path mapping for node node-flappy",
      } as const)
      .mockResolvedValueOnce({ allowed: true } as const)
      .mockResolvedValueOnce({
        allowed: false,
        code: "missing-project-mapping",
        reason: "Execution blocked: project has no path mapping for node node-flappy",
      } as const);
    const scheduler = new Scheduler(store, { validateNodeDispatch });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();
    await scheduler.schedule();
    await scheduler.schedule();

    const missingMappingLogs = vi.mocked(store.logEntry).mock.calls.filter(([, message]) =>
      String(message).includes("project has no path mapping for node node-flappy"),
    );
    expect(missingMappingLogs).toHaveLength(2);
  });

  it("does not run unavailable-node fallback policy when mapping validation fails", async () => {
    const task = createMockTask({ id: "FN-116", nodeId: "node-error" });
    const store = createMockStore(task, {
      maxConcurrent: 1,
      maxWorktrees: 1,
      unavailableNodePolicy: "fallback-local",
    });
    const healthMonitor = createMockHealthMonitor({ "node-error": "error" });
    const validateNodeDispatch = vi.fn().mockResolvedValue({
      allowed: false,
      code: "missing-project-mapping",
      reason: "Execution blocked: project has no path mapping for node node-error",
    } as const);
    const scheduler = new Scheduler(store, { nodeHealthMonitor: healthMonitor, validateNodeDispatch });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect((healthMonitor.getNodeHealth as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalledWith(
      task.id,
      "Node node-error is error; falling back to local per policy",
    );
  });

  it("preserves health-based fallback behavior for mapped nodes", async () => {
    const task = createMockTask({ id: "FN-117", nodeId: "node-error" });
    const store = createMockStore(task, {
      maxConcurrent: 1,
      maxWorktrees: 1,
      unavailableNodePolicy: "fallback-local",
    });
    const healthMonitor = createMockHealthMonitor({ "node-error": "error" });
    const validateNodeDispatch = allowDispatchValidator();
    const scheduler = new Scheduler(store, { nodeHealthMonitor: healthMonitor, validateNodeDispatch });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      effectiveNodeId: null,
      effectiveNodeSource: "local",
    }));
    expect(store.logEntry).toHaveBeenCalledWith(task.id, "Node node-error is error; falling back to local per policy");
  });

  it("blocks dispatch when node is unhealthy and policy is block", async () => {
    const task = createMockTask({ id: "FN-104", nodeId: "node-offline" });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1, unavailableNodePolicy: "block" });
    const healthMonitor = createMockHealthMonitor({ "node-offline": "offline" });
    const scheduler = new Scheduler(store, { nodeHealthMonitor: healthMonitor });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(task.id, "Node node-offline is offline; policy is block");
    expect(schedulerLog.log).toHaveBeenCalledWith("Task FN-104 dispatch blocked — Node node-offline is offline; policy is block");
  });

  it("deduplicates blocked log entries across polling cycles", async () => {
    const task = createMockTask({ id: "FN-105", nodeId: "node-offline" });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1, unavailableNodePolicy: "block" });
    const healthMonitor = createMockHealthMonitor({ "node-offline": "offline" });
    const scheduler = new Scheduler(store, { nodeHealthMonitor: healthMonitor });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();
    await scheduler.schedule();

    const blockLogs = vi.mocked(store.logEntry).mock.calls.filter(([, message]) =>
      String(message).includes("Node node-offline is offline; policy is block"),
    );
    expect(blockLogs).toHaveLength(1);
  });

  it("falls back to local dispatch when node is unhealthy and policy is fallback-local", async () => {
    const task = createMockTask({ id: "FN-106", nodeId: "node-error" });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1, unavailableNodePolicy: "fallback-local" });
    const healthMonitor = createMockHealthMonitor({ "node-error": "error" });
    const scheduler = new Scheduler(store, { nodeHealthMonitor: healthMonitor });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      effectiveNodeId: null,
      effectiveNodeSource: "local",
    }));
    expect(store.logEntry).toHaveBeenCalledWith(task.id, "Node node-error is error; falling back to local per policy");
  });

  it("dispatches normally when node is online with block policy", async () => {
    const task = createMockTask({ id: "FN-107", nodeId: "node-online" });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1, unavailableNodePolicy: "block" });
    const healthMonitor = createMockHealthMonitor({ "node-online": "online" });
    const scheduler = new Scheduler(store, { nodeHealthMonitor: healthMonitor });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      effectiveNodeId: "node-online",
      effectiveNodeSource: "task-override",
    }));
  });

  it("dispatches normally when node health is unknown", async () => {
    const task = createMockTask({ id: "FN-108", nodeId: "node-unknown" });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1, unavailableNodePolicy: "block" });
    const healthMonitor = createMockHealthMonitor({ "node-unknown": undefined });
    const scheduler = new Scheduler(store, { nodeHealthMonitor: healthMonitor });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      effectiveNodeId: "node-unknown",
      effectiveNodeSource: "task-override",
    }));
  });

  it("clears block dedup after successful dispatch", async () => {
    const task = createMockTask({ id: "FN-109", nodeId: "node-flaky" });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1, unavailableNodePolicy: "block" });
    const getNodeHealth = vi
      .fn()
      .mockReturnValueOnce("offline" satisfies NodeStatus)
      .mockReturnValueOnce("online" satisfies NodeStatus)
      .mockReturnValueOnce("offline" satisfies NodeStatus);
    const scheduler = new Scheduler(store, {
      nodeHealthMonitor: { getNodeHealth } as unknown as import("../node-health-monitor.js").NodeHealthMonitor,
    });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();
    await scheduler.schedule();
    await scheduler.schedule();

    const blockLogs = vi.mocked(store.logEntry).mock.calls.filter(([, message]) =>
      String(message).includes("Node node-flaky is offline; policy is block"),
    );
    expect(blockLogs).toHaveLength(2);
  });

  it("skips policy check when no health monitor is provided", async () => {
    const task = createMockTask({ id: "FN-110", nodeId: "node-1" });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1, unavailableNodePolicy: "block" });
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      effectiveNodeId: "node-1",
      effectiveNodeSource: "task-override",
    }));
  });

  it("never queries health for local tasks", async () => {
    const task = createMockTask({ id: "FN-111", nodeId: undefined });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1 });
    const healthMonitor = createMockHealthMonitor({});
    const scheduler = new Scheduler(store, { nodeHealthMonitor: healthMonitor });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect((healthMonitor.getNodeHealth as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
