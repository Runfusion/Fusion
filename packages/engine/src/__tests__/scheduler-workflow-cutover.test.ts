import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTransitionRejection, TransitionRejectionError, buildBootstrapPrompt, type Task, type TaskStore, type WorkflowIr } from "@fusion/core";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Scheduler } from "../scheduler.js";
import { AgentSemaphore } from "../concurrency.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn() };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn() };
});

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-100",
    title: "Workflow task",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function storeWith(
  tasks: Task[],
  settings: Record<string, unknown> = {},
  workflows: { selections?: Record<string, string>; definitions?: Record<string, WorkflowIr> } = {},
): TaskStore {
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  return {
    listTasks: vi.fn(async () => [...byId.values()]),
    getTask: vi.fn(async (id: string) => byId.get(id) ?? null),
    getSettings: vi.fn(async () => ({
      maxConcurrent: 2,
      maxWorktrees: 4,
      experimentalFeatures: { workflowColumns: false },
      ...settings,
    })),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({ ...settings, ...patch })),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const current = byId.get(id);
      if (current) Object.assign(current, patch);
      return current as Task;
    }),
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const current = byId.get(id);
      if (current) current.column = column;
      return current as Task;
    }),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    logEntry: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => "/tmp/project"),
    getTasksDir: vi.fn(() => "/tmp/project/.fusion/tasks"),
    on: vi.fn(),
    off: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getMissionStore: vi.fn(() => ({
      listMissions: () => [],
      listGoalIdsForMission: () => [],
    })),
    getTaskWorkflowSelection: vi.fn((id: string) => {
      const workflowId = workflows.selections?.[id];
      return workflowId ? { workflowId, stepIds: [] } : undefined;
    }),
    getWorkflowDefinition: vi.fn(async (id: string) => {
      const ir = workflows.definitions?.[id];
      return ir ? { ir } : undefined;
    }),
  } as unknown as TaskStore;
}

describe("Scheduler workflow cutover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue("# Task\nBody");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the engine active heartbeat at most once per poll interval and skips while paused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T00:00:00.000Z"));
    const store = storeWith([], { pollIntervalMs: 15_000 });
    const scheduler = new Scheduler(store, { onSchedule: vi.fn() });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();
    await scheduler.schedule();
    expect(store.updateSettings).toHaveBeenCalledTimes(1);
    expect(store.updateSettings).toHaveBeenCalledWith({ engineLastActiveAt: "2026-06-25T00:00:00.000Z" });

    vi.setSystemTime(new Date("2026-06-25T00:00:15.000Z"));
    await scheduler.schedule();
    expect(store.updateSettings).toHaveBeenCalledTimes(2);

    vi.mocked(store.getSettings).mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 15_000, enginePaused: true } as any);
    vi.setSystemTime(new Date("2026-06-25T00:00:30.000Z"));
    await scheduler.schedule();
    expect(store.updateSettings).toHaveBeenCalledTimes(2);
  });

  it("uses the workflow sweep for todo pickup even when stale workflowColumns=false is persisted", async () => {
    const ready = task({ id: "FN-100" });
    const store = storeWith([ready]);
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledWith("FN-100", "in-progress", expect.objectContaining({
      moveSource: "scheduler",
      allocateWorktree: expect.any(Function),
    }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-100", expect.objectContaining({
      status: null,
      blockedBy: null,
      mergeRetries: 0,
      effectiveNodeId: null,
      effectiveNodeSource: "local",
    }));
    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-100", column: "in-progress" }));
  });

  it("does not dispatch an operator-parked todo task when only userPaused remains true", async () => {
    const parked = task({ id: "FN-PAUSED", paused: false, userPaused: true });
    const store = storeWith([parked]);
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(onSchedule).not.toHaveBeenCalled();
    expect(parked.column).toBe("todo");
  });

  /*
  FNXC:WorkflowScheduling 2026-07-07-00:00:
  FN-7648 regression: a custom workflow's intake column can be renamed away from
  the literal "todo" id (e.g. `ideas`). An unplanned card resting there (still
  carrying the bootstrap-stub PROMPT.md) must stay held — the `reserveSlot`
  guard used to be keyed on `task.column === "todo"` and silently released this
  kind of card straight into `in-progress`.
  */
  it("FN-7648: keeps an unplanned card in a renamed custom intake column held instead of releasing it", async () => {
    const unplanned = task({ id: "FN-300", column: "ideas" });
    const renamedIntakeIr: WorkflowIr = {
      version: "v2",
      name: "renamed-intake",
      columns: [
        { id: "ideas", name: "Ideas", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
        { id: "in-progress", name: "in-progress", traits: [{ trait: "wip", config: { limit: 5 } }] },
        { id: "done", name: "done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "ideas" },
        { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute", prompt: "Do the work" } },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "execute", condition: "success" },
        { from: "execute", to: "end", condition: "success" },
      ],
    } as WorkflowIr;
    const store = storeWith([unplanned], {}, {
      selections: { "FN-300": "custom:renamed-intake" },
      definitions: { "custom:renamed-intake": renamedIntakeIr },
    });
    vi.mocked(readFile).mockImplementation(async () => buildBootstrapPrompt("FN-300", unplanned.title, unplanned.description));
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTask).not.toHaveBeenCalledWith("FN-300", "in-progress", expect.anything());
    expect(unplanned.column).toBe("ideas");
    expect(onSchedule).not.toHaveBeenCalledWith(expect.objectContaining({ id: "FN-300" }));
  });

  it("queues without dispatch when ephemeral agents are disabled and no agent store is available", async () => {
    const ready = task({ id: "FN-101" });
    const store = storeWith([ready], { ephemeralAgentsEnabled: false });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-101", { status: "queued" });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-101",
      "queued — permanent executor selection unavailable (ephemeral agents disabled)",
    );
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-101", "in-progress", expect.anything());
    expect(onSchedule).not.toHaveBeenCalled();
    expect(ready.column).toBe("todo");
  });

  it("passes worktree naming and directory settings to the workflow release allocator", async () => {
    const ready = task({ id: "FN-102" });
    const store = storeWith([ready], {
      worktreeNaming: "task-id",
      worktreesDir: "custom-worktrees",
    });
    const scheduler = new Scheduler(store, { onSchedule: vi.fn() });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    const moveOptions = vi.mocked(store.moveTask).mock.calls[0]?.[2] as {
      allocateWorktree?: (reservedNames: Set<string>) => string | null;
    };
    expect(moveOptions.allocateWorktree?.(new Set())).toBe("/tmp/project/custom-worktrees/fn-102");
  });

  it("continues executor handoff for all released tasks when post-release metadata or logs fail", async () => {
    const first = task({ id: "FN-201", status: "queued" });
    const second = task({ id: "FN-202", status: "queued" });
    const store = storeWith([first, second], { maxConcurrent: 4, maxWorktrees: 4 });
    const updateImpl = vi.mocked(store.updateTask).getMockImplementation()!;
    vi.mocked(store.updateTask).mockImplementation(async (id, patch) => {
      if (id === "FN-201" && "lastDispatchAt" in patch) {
        throw new Error("metadata write failed");
      }
      return updateImpl(id, patch);
    });
    vi.mocked(store.logEntry).mockImplementation(async (id, message) => {
      if (id === "FN-201" && message.startsWith("Node routing resolved")) {
        throw new Error("log write failed");
      }
    });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({
      id: "FN-201",
      column: "in-progress",
      status: undefined,
      effectiveNodeSource: "local",
    }));
    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({
      id: "FN-202",
      column: "in-progress",
      status: undefined,
      effectiveNodeSource: "local",
    }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-202", expect.objectContaining({
      status: null,
      effectiveNodeSource: "local",
    }));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-202",
      "Node routing resolved: local (source: local)",
    );
  });

  it("keeps dependency-blocked todo tasks queued on the workflow sweep path", async () => {
    const blocker = task({ id: "FN-001", column: "todo" });
    const dependent = task({ id: "FN-002", dependencies: ["FN-001"] });
    const store = storeWith([blocker, dependent]);
    const onBlocked = vi.fn();
    const scheduler = new Scheduler(store, { onBlocked });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-002", {
      status: "queued",
      blockedBy: "FN-001",
    });
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-002", "in-progress", expect.anything());
    expect(onBlocked).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-002" }), ["FN-001"]);
  });

  it("does not clear status or release work when maxConcurrent is full", async () => {
    const active = task({ id: "FN-001", column: "in-progress" });
    const ready = task({ id: "FN-002", status: "queued" });
    const store = storeWith([active, ready], { maxConcurrent: 1, maxWorktrees: 4 });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTask).not.toHaveBeenCalledWith("FN-002", "in-progress", expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", expect.objectContaining({ status: null }));
    expect(onSchedule).not.toHaveBeenCalledWith(expect.objectContaining({ id: "FN-002" }));
    expect(ready.column).toBe("todo");
  });

  it("does not clear status or release work when maxWorktrees is full", async () => {
    const active = task({ id: "FN-001", column: "in-progress" });
    const ready = task({ id: "FN-002", status: "queued" });
    const store = storeWith([active, ready], { maxConcurrent: 4, maxWorktrees: 1 });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTask).not.toHaveBeenCalledWith("FN-002", "in-progress", expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", expect.objectContaining({ status: null }));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-002",
      expect.stringContaining("gate=maxWorktrees; maxConcurrent used=1/4"),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-002",
      expect.stringContaining("maxWorktrees used=1/1"),
    );
    expect(onSchedule).not.toHaveBeenCalledWith(expect.objectContaining({ id: "FN-002" }));
    expect(ready.column).toBe("todo");
  });

  it("does not release work when already over maxWorktrees even if maxConcurrent has slack", async () => {
    const active = Array.from({ length: 5 }, (_, index) => task({ id: `FN-10${index}`, column: "in-progress" }));
    const ready = task({ id: "FN-200", status: "queued" });
    const store = storeWith([...active, ready], { maxConcurrent: 10, maxWorktrees: 4 });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTask).not.toHaveBeenCalledWith("FN-200", "in-progress", expect.anything());
    expect(store.updateTask).toHaveBeenCalledWith("FN-200", { status: "queued" });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-200",
      expect.stringContaining("gate=maxWorktrees; maxConcurrent used=5/10"),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-200",
      expect.stringContaining("maxWorktrees used=5/4"),
    );
    expect(onSchedule).not.toHaveBeenCalled();
    expect(ready.column).toBe("todo");
  });

  it("releases one ready task when maxWorktrees has exactly one remaining slot and maxConcurrent is higher", async () => {
    const active = Array.from({ length: 3 }, (_, index) => task({ id: `FN-30${index}`, column: "in-progress" }));
    const first = task({ id: "FN-401", status: "queued" });
    const second = task({ id: "FN-402", status: "queued" });
    const store = storeWith([...active, first, second], { maxConcurrent: 10, maxWorktrees: 4 });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledTimes(1);
    expect(store.moveTask).toHaveBeenCalledWith("FN-401", "in-progress", expect.anything());
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-402", "in-progress", expect.anything());
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-402",
      expect.stringContaining("gate=maxWorktrees; maxConcurrent used=4/10"),
    );
    expect(onSchedule).toHaveBeenCalledTimes(1);
  });

  it("reserves same-sweep capacity so only one ready task is released into one slot", async () => {
    const first = task({ id: "FN-001", status: "queued" });
    const second = task({ id: "FN-002", status: "queued" });
    const store = storeWith([first, second], { maxConcurrent: 1, maxWorktrees: 1 });
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledTimes(1);
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-progress", expect.anything());
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-002", "in-progress", expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", expect.objectContaining({ status: null }));
    expect(onSchedule).toHaveBeenCalledTimes(1);
    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-001", column: "in-progress" }));
    expect(second.column).toBe("todo");
    expect(second.status).toBe("queued");
  });

  it("leaves a task queued when the authoritative release move rejects after reservation", async () => {
    const ready = task({ id: "FN-002", status: "queued" });
    const store = storeWith([ready], { maxConcurrent: 4, maxWorktrees: 4 });
    vi.mocked(store.moveTask).mockRejectedValueOnce(
      new TransitionRejectionError(
        makeTransitionRejection(
          "capacity-exhausted",
          "transition.rejected.capacityExhausted",
          true,
          "Column is at capacity",
        ),
        "Column is at capacity",
      ),
    );
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledWith("FN-002", "in-progress", expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", expect.objectContaining({ status: null }));
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-002",
      expect.stringContaining("Node routing resolved"),
    );
    expect(onSchedule).not.toHaveBeenCalled();
    expect(ready.column).toBe("todo");
    expect(ready.status).toBe("queued");
  });

  it("does not release work when the shared semaphore is saturated", async () => {
    const ready = task({ id: "FN-002", status: "queued" });
    const store = storeWith([ready], { maxConcurrent: 4, maxWorktrees: 4 });
    const semaphore = new AgentSemaphore(1);
    await semaphore.acquire();
    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, { onSchedule, semaphore });
    (scheduler as unknown as { running: boolean }).running = true;

    try {
      await scheduler.schedule();
    } finally {
      semaphore.release();
    }

    expect(store.moveTask).not.toHaveBeenCalledWith("FN-002", "in-progress", expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", expect.objectContaining({ status: null }));
    expect(onSchedule).not.toHaveBeenCalled();
    expect(ready.column).toBe("todo");
  });
});
