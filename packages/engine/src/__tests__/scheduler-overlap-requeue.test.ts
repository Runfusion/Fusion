import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentStore, Task, TaskStore } from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import { EphemeralWorkerManager } from "../ephemeral-worker-manager.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

/**
 * FN-4249 call sequence under test:
 * 1) EphemeralWorkerManager.onTaskStart(task) links assigned durable agent to the task and flips it active→running.
 * 2) Scheduler.schedule() later sees file-scope overlap and requeues the todo task with status="queued".
 * 3) Before the fix, overlap requeue never rolled back the durable agent row, leaving state="running" + executionTaskId.
 * 4) This test enforces the invariant: durable agents must not remain running against todo/queued tasks.
 */

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

type MutableAgent = Agent & { executionTaskId?: string | null };

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-100",
    description: "Test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    prompt: "",
    ...overrides,
  } as Task;
}

function createTaskStore(tasks: Task[]): TaskStore {
  const byId = new Map(tasks.map((task) => [task.id, task]));

  return {
    listTasks: vi.fn(async () => Array.from(byId.values())),
    getTask: vi.fn(async (id: string) => byId.get(id) ?? null),
    getSettings: vi.fn(async () => ({ maxConcurrent: 10, maxWorktrees: 10, groupOverlappingFiles: true })),
    getRootDir: vi.fn(() => "/tmp/project"),
    getTasksDir: vi.fn(() => "/tmp/project/.fusion/tasks"),
    parseFileScopeFromPrompt: vi.fn(async (taskId: string) => {
      if (taskId === "FN-001") return ["packages/engine/src/scheduler.ts"];
      if (taskId === "FN-100") return ["packages/engine/src/scheduler.ts"];
      return [];
    }),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const current = byId.get(id);
      if (!current) return;
      const updated = { ...current, ...patch } as Task;
      byId.set(id, updated);
    }),
    moveTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function createAgentStore(agents: MutableAgent[]): AgentStore {
  const byId = new Map(agents.map((agent) => [agent.id, { ...agent }]));

  return {
    getAgent: vi.fn(async (id: string) => byId.get(id) ?? null),
    updateAgentState: vi.fn(async (id: string, state: Agent["state"]) => {
      const existing = byId.get(id);
      if (!existing) return;
      existing.state = state;
    }),
    syncExecutionTaskLink: vi.fn(async (id: string, taskId?: string | null) => {
      const existing = byId.get(id);
      if (!existing) return;
      existing.executionTaskId = taskId ?? null;
    }),
  } as unknown as AgentStore;
}

describe("scheduler overlap requeue agent-state invariant (FN-4249)", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue("# Task\nDo something");
  });

  it("rolls back assigned durable agent from running when overlap requeues todo task", async () => {
    const blocker = createMockTask({ id: "FN-001", column: "in-progress" });
    const queuedCandidate = createMockTask({
      id: "FN-100",
      column: "todo",
      status: "todo",
      assignedAgentId: "agent-assigned",
    });

    const taskStore = createTaskStore([blocker, queuedCandidate]);
    const agentStore = createAgentStore([
      {
        id: "agent-assigned",
        name: "Assigned Agent",
        role: "executor",
        state: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as MutableAgent,
    ]);

    const workerManager = new EphemeralWorkerManager({
      agentStore,
      taskStore,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    await workerManager.onTaskStart(queuedCandidate);

    const scheduler = new Scheduler(taskStore);
    (scheduler as { running: boolean }).running = true;
    await scheduler.schedule();

    const agent = await agentStore.getAgent("agent-assigned") as MutableAgent;
    const task = await taskStore.getTask("FN-100");

    expect(task?.column).toBe("todo");
    expect(task?.status).toBe("queued");
    expect(agent.state).toBe("active");
    expect(agent.executionTaskId ?? null).toBeNull();
  });
});
