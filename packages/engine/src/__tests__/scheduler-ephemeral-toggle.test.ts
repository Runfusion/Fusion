import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Agent, Task, TaskStore } from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn() };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn() };
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-100",
    description: "test",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function makeAgent(overrides: Partial<Agent> & Pick<Agent, "id">): Agent {
  return {
    name: overrides.name ?? overrides.id,
    role: overrides.role ?? "executor",
    state: overrides.state ?? "idle",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    metadata: overrides.metadata ?? {},
    ...overrides,
  };
}

function createStore(task: Task, settings: Record<string, unknown>, tasksForList?: Task[]): TaskStore {
  const moveTask = vi.fn().mockResolvedValue(undefined);
  return {
    listTasks: vi.fn().mockImplementation(async () => tasksForList ?? [task]),
    getSettings: vi.fn().mockResolvedValue(settings),
    /*
    FNXC:EngineTests 2026-06-27-10:05:
    Scheduler fakes must expose the production `updateSettings` heartbeat write so ephemeral-agent dispatch assertions measure scheduler behavior instead of fake drift.
    */
    updateSettings: vi.fn().mockResolvedValue(settings),
    getTask: vi.fn().mockResolvedValue(task),
    updateTask: vi.fn().mockResolvedValue(undefined),
    moveTask,
    /*
    FNXC:EngineTests 2026-07-23-21:20:
    Scheduler dispatch now goes through the atomic `moveTaskIf` (user-paused dispatch fix, commit 0818fc1da).
    The fake delegates to the mock `moveTask` after the predicate passes so existing dispatch assertions on `store.moveTask` stay meaningful.
    */
    moveTaskIf: vi.fn(async (id: string, column: Task["column"], predicate: (live: Task) => boolean | Promise<boolean>, opts?: Record<string, unknown>) => {
      const cur = (tasksForList ?? [task]).find((t) => t.id === id) ?? task;
      if (!(await predicate(cur)) || cur.column === column) return { task: cur, moved: false };
      await moveTask(id, column, opts);
      cur.column = column;
      return { task: cur, moved: true };
    }),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/tmp/project"),
    getTasksDir: vi.fn().mockReturnValue("/tmp/project/.fusion/tasks"),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

async function runSchedulerOnce(scheduler: Scheduler): Promise<void> {
  await scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  scheduler.stop();
}

describe("Scheduler ephemeralAgentsEnabled toggle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue("# Prompt\n");
  });

  it("default on: dispatches without auto-assigned agent", async () => {
    const task = makeTask({ id: "FN-101" });
    const store = createStore(task, { maxConcurrent: 2, maxWorktrees: 4, ephemeralAgentsEnabled: true });
    const scheduler = new Scheduler(store);

    await runSchedulerOnce(scheduler);

    expect(store.updateTask).not.toHaveBeenCalledWith("FN-101", expect.objectContaining({ assignedAgentId: expect.any(String) }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-101", "in-progress", expect.any(Object));
  });

  it("off + no permanent executor: keeps task queued in todo", async () => {
    const task = makeTask({ id: "FN-102" });
    const store = createStore(task, { maxConcurrent: 2, maxWorktrees: 4, ephemeralAgentsEnabled: false });
    const scheduler = new Scheduler(store, {
      agentStore: {
        listAgents: vi.fn().mockResolvedValue([]),
        getChainOfCommand: vi.fn().mockResolvedValue([]),
      } as never,
    });

    await runSchedulerOnce(scheduler);

    expect(store.updateTask).toHaveBeenCalledWith("FN-102", { status: "queued" });
    expect(store.logEntry).toHaveBeenCalledWith("FN-102", "queued — no permanent executor available (ephemeral agents disabled)");
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("off + permanent executor: assigns then dispatches", async () => {
    const task = makeTask({ id: "FN-103" });
    const store = createStore(task, { maxConcurrent: 2, maxWorktrees: 4, ephemeralAgentsEnabled: false });
    const scheduler = new Scheduler(store, {
      agentStore: {
        listAgents: vi.fn().mockResolvedValue([makeAgent({ id: "agent-1" })]),
        getChainOfCommand: vi.fn().mockResolvedValue([]),
      } as never,
    });

    await runSchedulerOnce(scheduler);

    expect(store.updateTask).toHaveBeenCalledWith("FN-103", { assignedAgentId: "agent-1" });
    expect(store.moveTask).toHaveBeenCalledWith("FN-103", "in-progress", expect.any(Object));
  });

  it("off + multiple executors: picks least-loaded", async () => {
    const task = makeTask({ id: "FN-104" });
    const tasks = [
      task,
      makeTask({ id: "FN-A", column: "in-progress", assignedAgentId: "agent-heavy" }),
      makeTask({ id: "FN-B", column: "todo", assignedAgentId: "agent-heavy" }),
      makeTask({ id: "FN-C", column: "in-review", assignedAgentId: "agent-light" }),
    ];
    const store = createStore(task, { maxConcurrent: 2, maxWorktrees: 4, ephemeralAgentsEnabled: false }, tasks);
    const scheduler = new Scheduler(store, {
      agentStore: {
        listAgents: vi.fn().mockResolvedValue([
          makeAgent({ id: "agent-heavy", createdAt: "2026-01-01T00:00:00.000Z" }),
          makeAgent({ id: "agent-light", createdAt: "2026-01-01T00:00:01.000Z" }),
        ]),
        getChainOfCommand: vi.fn().mockResolvedValue([]),
      } as never,
    });

    await runSchedulerOnce(scheduler);

    expect(store.updateTask).toHaveBeenCalledWith("FN-104", { assignedAgentId: "agent-light" });
    expect(store.moveTask).toHaveBeenCalledWith("FN-104", "in-progress", expect.any(Object));
  });
});
