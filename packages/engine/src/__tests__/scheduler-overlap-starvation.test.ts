import { beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../scheduler.js";
import type { Agent, AgentStore, Task, TaskStore } from "@fusion/core";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "task",
    description: "",
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

function createAgentStore(agents: Agent[]): AgentStore {
  return {
    listAgents: vi.fn(async (filter?: { state?: Agent["state"]; includeEphemeral?: boolean }) => {
      return agents.filter((agent) => !filter?.state || agent.state === filter.state);
    }),
    getActiveHeartbeatRun: vi.fn(async () => null),
    updateAgentState: vi.fn(async (agentId: string, state: Agent["state"]) => {
      const agent = agents.find((candidate) => candidate.id === agentId);
      if (agent) agent.state = state;
    }),
    syncExecutionTaskLink: vi.fn(async (agentId: string, taskId?: string) => {
      const agent = agents.find((candidate) => candidate.id === agentId);
      if (agent) agent.taskId = taskId;
    }),
  } as unknown as AgentStore;
}

function createStore(tasks: Task[], scopes: Record<string, string[]>): TaskStore {
  const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task) Object.assign(task, patch);
    return task as Task;
  });
  const moveTask = vi.fn(async (id: string, column: Task["column"]) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task) task.column = column;
    return task as Task;
  });

  return {
    listTasks: vi.fn(async () => tasks),
    getSettings: vi.fn(async () => ({ maxConcurrent: 10, maxWorktrees: 10, groupOverlappingFiles: true })),
    parseFileScopeFromPrompt: vi.fn(async (id: string) => scopes[id] ?? []),
    updateTask,
    moveTask,
    getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id) ?? null),
    logEntry: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => "/tmp/project"),
    getTasksDir: vi.fn(() => "/tmp/project/.fusion/tasks"),
    on: vi.fn(),
    off: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
  } as unknown as TaskStore;
}

describe("scheduler overlap starvation regression (FN-057)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Scheduler.prototype as any, "validateTaskFilesystem").mockResolvedValue({ valid: true });
  });

  it("does not let dependency-blocked queued overlap starve ready work", async () => {
    const tasks = [
      makeTask({ id: "FN-039", column: "in-progress", priority: "normal" }),
      makeTask({
        id: "FN-028",
        column: "todo",
        status: "queued",
        priority: "urgent",
        dependencies: ["FN-039"],
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      makeTask({
        id: "FN-030",
        column: "todo",
        priority: "normal",
        createdAt: "2026-01-01T00:01:00.000Z",
      }),
    ];
    const store = createStore(tasks, {
      "FN-039": ["packages/core/src/store.ts"],
      "FN-028": ["packages/engine/src/scheduler.ts"],
      "FN-030": ["packages/engine/src/scheduler.ts"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-028", { status: "queued", blockedBy: "FN-039" });
    expect(store.logEntry).toHaveBeenCalledWith("FN-028", "queued — unmet dependencies: FN-039");
    expect(store.moveTask).toHaveBeenCalledWith("FN-030", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-030",
      expect.objectContaining({ status: "queued", overlapBlockedBy: "FN-028" }),
    );
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-030",
      "queued — deferred for higher-priority runnable queued task FN-028 (overlap)",
    );
  });


  it("does not defer ready work behind queued overlap blocked by an active lease", async () => {
    const tasks = [
      makeTask({ id: "FN-039", column: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-028", column: "todo", status: "queued", priority: "urgent", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeTask({ id: "FN-030", column: "todo", priority: "normal", createdAt: "2026-01-01T00:01:00.000Z" }),
    ];
    const store = createStore(tasks, {
      "FN-039": ["packages/engine/src/scheduler.ts"],
      "FN-028": ["packages/engine/src/scheduler.ts", "packages/core/src/store.ts"],
      "FN-030": ["packages/core/src/store.ts"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-028",
      expect.objectContaining({ status: "queued", overlapBlockedBy: "FN-039" }),
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-030", "in-progress", expect.anything());
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-030",
      "queued — deferred for higher-priority runnable queued task FN-028 (overlap)",
    );
  });

  it("keeps active file-scope leases bounded while non-overlapping ready work proceeds", async () => {
    const tasks = [
      makeTask({ id: "FN-039", column: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-030", column: "todo", priority: "urgent" }),
      makeTask({ id: "FN-031", column: "todo", priority: "normal", createdAt: "2026-01-01T00:01:00.000Z" }),
    ];
    const store = createStore(tasks, {
      "FN-039": ["packages/engine/src/scheduler.ts"],
      "FN-030": ["packages/engine/src/scheduler.ts"],
      "FN-031": ["packages/core/src/store.ts"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-030", {
      status: "queued",
      blockedBy: null,
      overlapBlockedBy: "FN-039",
    });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-030",
      "queued — blocked by active file-scope lease FN-039 (column=in-progress)",
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-031", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
  });

  it("FN-6954: clears stale running durable agents when overlap requeue parks todo task", async () => {
    const tasks = [
      makeTask({ id: "FN-6827", column: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-6709", column: "todo", priority: "urgent" }),
    ];
    const agents = [{ id: "agent-backend", state: "running", taskId: "FN-6709" } as Agent];
    const agentStore = createAgentStore(agents);
    const store = createStore(tasks, {
      "FN-6827": ["packages/engine/src/scheduler.ts"],
      "FN-6709": ["packages/engine/src/scheduler.ts"],
    });

    const scheduler = new Scheduler(store, { agentStore, hasActiveAgentExecution: () => false });
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-6709", {
      status: "queued",
      blockedBy: null,
      overlapBlockedBy: "FN-6827",
    });
    expect(agents[0]).toMatchObject({ state: "active", taskId: undefined });
    expect((agentStore as any).updateAgentState).toHaveBeenCalledWith("agent-backend", "active");
    expect((agentStore as any).syncExecutionTaskLink).toHaveBeenCalledWith("agent-backend", undefined);
    expect(tasks.find((task) => task.id === "FN-6709")).toMatchObject({ status: "queued", overlapBlockedBy: "FN-6827" });
  });

  it("FN-6954: preserves running durable agent when overlap requeue has live execution proof", async () => {
    const tasks = [
      makeTask({ id: "FN-6827", column: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-6709", column: "todo", priority: "urgent" }),
    ];
    const agents = [{ id: "agent-backend", state: "running", taskId: "FN-6709" } as Agent];
    const agentStore = createAgentStore(agents);
    const store = createStore(tasks, {
      "FN-6827": ["packages/engine/src/scheduler.ts"],
      "FN-6709": ["packages/engine/src/scheduler.ts"],
    });

    const scheduler = new Scheduler(store, { agentStore, hasActiveAgentExecution: (agentId) => agentId === "agent-backend" });
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect((agentStore as any).updateAgentState).not.toHaveBeenCalled();
    expect((agentStore as any).syncExecutionTaskLink).not.toHaveBeenCalled();
    expect(agents[0]).toMatchObject({ state: "running", taskId: "FN-6709" });
    expect(tasks.find((task) => task.id === "FN-6709")).toMatchObject({ status: "queued", overlapBlockedBy: "FN-6827" });
  });

  it("does not defer FN-078-style ready work behind non-runnable queued overlaps", async () => {
    const tasks = [
      makeTask({ id: "FN-069", column: "todo", status: "queued", priority: "high" }),
      makeTask({
        id: "FN-070",
        column: "todo",
        status: "queued",
        priority: "urgent",
        dependencies: ["FN-069"],
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      makeTask({
        id: "FN-045",
        column: "todo",
        status: "queued",
        priority: "high",
        overlapBlockedBy: "FN-033",
        createdAt: "2026-01-01T00:01:00.000Z",
      }),
      makeTask({ id: "FN-033", column: "in-progress", status: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-078", column: "todo", priority: "normal", createdAt: "2026-01-01T00:02:00.000Z" }),
    ];
    const store = createStore(tasks, {
      "FN-033": ["packages/atlas/README.md"],
      "FN-045": ["packages/atlas/README.md"],
      "FN-070": ["packages/atlas/notes.md"],
      "FN-078": ["packages/atlas/notes.md"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-070", { status: "queued", blockedBy: "FN-069" });
    expect(store.logEntry).toHaveBeenCalledWith("FN-070", "queued — unmet dependencies: FN-069");
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-045",
      expect.objectContaining({ status: "queued", overlapBlockedBy: "FN-033" }),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-045",
      "queued — blocked by active file-scope lease FN-033 (column=in-progress)",
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-078", "in-progress", expect.anything());
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-078",
      "queued — deferred for higher-priority runnable queued task FN-070 (overlap)",
    );
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-078",
      "queued — deferred for higher-priority runnable queued task FN-045 (overlap)",
    );
  });

  it("allows FN-158-style coordination backlog audit to run while implementation lease is active", async () => {
    const tasks = [
      makeTask({ id: "FN-118", column: "in-progress", priority: "normal", title: "Implement local skill loading" }),
      makeTask({
        id: "FN-158",
        column: "todo",
        status: "queued",
        overlapBlockedBy: "FN-118",
        priority: "normal",
        title: "Backlog flow audit and next-task recommendations",
        description: "Audit backlog routing and document recommendations; no code delivery expected",
        noCommitsExpected: true,
      }),
    ];
    const store = createStore(tasks, {
      "FN-118": ["packages/engine/src/scheduler.ts", ".fusion/tasks/FN-158/task.json"],
      "FN-158": ["docs/task-management.md", ".changeset/*.md", ".fusion/tasks/FN-158/task.json"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledWith("FN-158", "in-progress", expect.anything());
    expect(store.updateTask).toHaveBeenCalledWith("FN-158", { overlapBlockedBy: null });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-158",
      "coordination/no-commit task bypassed non-implementation overlap lease",
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-158",
      expect.objectContaining({ overlapBlockedBy: "FN-118" }),
    );
  });

  it("does not use queued candidates that become non-runnable after earlier dispatch in the same pass", async () => {
    const tasks = [
      makeTask({ id: "FN-033", column: "todo", priority: "urgent", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeTask({ id: "FN-045", column: "todo", status: "queued", priority: "high", createdAt: "2026-01-01T00:01:00.000Z" }),
      makeTask({ id: "FN-078", column: "todo", priority: "normal", createdAt: "2026-01-01T00:02:00.000Z" }),
    ];
    const store = createStore(tasks, {
      "FN-033": ["packages/atlas/docs/README.md"],
      "FN-045": ["packages/atlas/docs/README.md", "packages/atlas/notes/today.md"],
      "FN-078": ["packages/atlas/notes/today.md"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledWith("FN-033", "in-progress", expect.anything());
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-045",
      expect.objectContaining({ status: "queued", overlapBlockedBy: "FN-033" }),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-045",
      "queued — blocked by active file-scope lease FN-033 (column=in-progress)",
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-078", "in-progress", expect.anything());
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-078",
      "queued — deferred for higher-priority runnable queued task FN-045 (overlap)",
    );
  });

  it("clears stale overlapBlockedBy when no runnable queued overlap blocker exists", async () => {
    const tasks = [
      makeTask({ id: "FN-100", column: "todo", priority: "normal", overlapBlockedBy: "FN-070" }),
      makeTask({ id: "FN-070", column: "todo", status: "queued", priority: "urgent", dependencies: ["FN-069"] }),
      makeTask({ id: "FN-069", column: "todo", status: "queued", priority: "high" }),
    ];
    const store = createStore(tasks, {
      "FN-100": ["packages/engine/src/scheduler.ts"],
      "FN-070": ["packages/engine/src/scheduler.ts"],
      "FN-069": ["packages/core/src/store.ts"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-100", { overlapBlockedBy: null });
    expect(store.moveTask).toHaveBeenCalledWith("FN-100", "in-progress", expect.anything());
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-100",
      "queued — deferred for higher-priority runnable queued task FN-070 (overlap)",
    );
  });

  it("does not preserve FN-779/FN-756 poisoned cross-repository blocker after write-scope sanitization", async () => {
    const tasks = [
      makeTask({ id: "FN-756", column: "in-progress", priority: "normal", title: "iPad mobile XCUITest work" }),
      makeTask({
        id: "FN-779",
        column: "todo",
        status: "queued",
        priority: "high",
        overlapBlockedBy: "FN-756",
        title: "Fusion engine heartbeat suppression",
      }),
    ];
    const store = createStore(tasks, {
      "FN-756": ["project.yml", "AtlasNotes.xcodeproj/**", "Tests/AtlasNotesMobileUITests/**", "Packages/MobileApp/**"],
      "FN-779": ["packages/core/**", "packages/engine/**", "packages/dashboard/**", "packages/cli/**"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-779", { overlapBlockedBy: null });
    expect(store.moveTask).toHaveBeenCalledWith("FN-779", "in-progress", expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-779",
      expect.objectContaining({ status: "queued", overlapBlockedBy: "FN-756" }),
    );
  });

  it("keeps true Atlas hot-file-family overlaps blocked", async () => {
    const tasks = [
      makeTask({ id: "FN-756", column: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-800", column: "todo", priority: "high" }),
    ];
    const store = createStore(tasks, {
      "FN-756": ["project.yml", "AtlasNotes.xcodeproj/**", "Tests/AtlasNotesMobileUITests/**", "Packages/MobileApp/**"],
      "FN-800": ["Tests/AtlasNotesMobileUITests/**", "Packages/MobileApp/**"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-800", {
      status: "queued",
      blockedBy: null,
      overlapBlockedBy: "FN-756",
    });
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-800", "in-progress", expect.anything());
  });

  it("reroutes a stale overlap blocker to another current active lease", async () => {
    const tasks = [
      makeTask({ id: "FN-OLD", column: "done", priority: "normal" }),
      makeTask({ id: "FN-NEW", column: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-900", column: "todo", status: "queued", priority: "high", overlapBlockedBy: "FN-OLD" }),
    ];
    const store = createStore(tasks, {
      "FN-OLD": ["packages/core/src/store.ts"],
      "FN-NEW": ["packages/engine/src/scheduler.ts"],
      "FN-900": ["packages/engine/src/scheduler.ts"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-900", {
      status: "queued",
      blockedBy: null,
      overlapBlockedBy: "FN-NEW",
    });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-900",
      "queued — blocked by active file-scope lease FN-NEW (column=in-progress)",
    );
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-900", "in-progress", expect.anything());
  });

  it("clears an absent overlap blocker only after confirming no current overlap remains", async () => {
    const tasks = [
      makeTask({ id: "FN-901", column: "todo", status: "queued", priority: "normal", overlapBlockedBy: "FN-MISSING" }),
    ];
    const store = createStore(tasks, {
      "FN-901": ["packages/engine/src/scheduler.ts"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-901", { overlapBlockedBy: null });
    expect(store.moveTask).toHaveBeenCalledWith("FN-901", "in-progress", expect.anything());
  });

});
