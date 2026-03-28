import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSemaphore } from "./concurrency.js";

// Mock createKbAgent and reviewStep before importing TriageProcessor
vi.mock("./pi.js", () => ({
  createKbAgent: vi.fn(),
}));

vi.mock("./reviewer.js", () => ({
  reviewStep: vi.fn(),
}));

import { TriageProcessor, buildSpecificationPrompt, type AttachmentContent } from "./triage.js";
import { createKbAgent } from "./pi.js";
import { reviewStep } from "./reviewer.js";
import type { TaskDetail } from "@kb/core";

const mockedReviewStep = vi.mocked(reviewStep);

const mockedCreateHaiAgent = vi.mocked(createKbAgent);

function createMockStore(tasks: any[] = []) {
  const listeners = new Map<string, Function[]>();
  const store = {
    on: vi.fn((event: string, fn: Function) => {
      const existing = listeners.get(event) || [];
      existing.push(fn);
      listeners.set(event, existing);
    }),
    /** Trigger registered listeners for an event (test helper). */
    _trigger(event: string, ...args: any[]) {
      for (const fn of listeners.get(event) || []) fn(...args);
    },
    listTasks: vi.fn().mockResolvedValue(tasks),
    getTask: vi.fn().mockResolvedValue({
      id: "KB-001",
      title: "Test",
      description: "Test task",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: "# test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    updateTask: vi.fn().mockResolvedValue({}),
    moveTask: vi.fn().mockResolvedValue({}),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    logEntry: vi.fn().mockResolvedValue({}),
    deleteTask: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue({}),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    }),
  };
  return store as any;
}

function createMockTaskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "KB-001",
    title: "Test Task",
    description: "A test task",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prompt: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("TriageProcessor with semaphore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acquires semaphore before creating agent and releases after", async () => {
    const sem = new AgentSemaphore(1);
    const store = createMockStore();
    const acquireSpy = vi.spyOn(sem, "acquire");
    const releaseSpy = vi.spyOn(sem, "release");

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test", { semaphore: sem });

    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Semaphore was used via run() which calls acquire + release
    expect(acquireSpy).toHaveBeenCalledOnce();
    expect(releaseSpy).toHaveBeenCalledOnce();
    expect(mockedCreateHaiAgent).toHaveBeenCalledOnce();
    expect(sem.activeCount).toBe(0);
  });

  it("releases semaphore on agent error", async () => {
    const sem = new AgentSemaphore(1);
    const store = createMockStore();

    mockedCreateHaiAgent.mockRejectedValue(new Error("agent failed"));

    const onError = vi.fn();
    const triage = new TriageProcessor(store, "/tmp/test", {
      semaphore: sem,
      onSpecifyError: onError,
    });

    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(sem.activeCount).toBe(0);
    expect(onError).toHaveBeenCalled();
  });

  it("concurrent specifyTask calls respect semaphore limit", async () => {
    const sem = new AgentSemaphore(1);
    const store = createMockStore();
    let concurrent = 0;
    let maxConcurrent = 0;

    mockedCreateHaiAgent.mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            await new Promise((r) => setTimeout(r, 10));
            concurrent--;
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const triage = new TriageProcessor(store, "/tmp/test", { semaphore: sem });

    const task = (id: string) => ({
      id,
      title: "Test",
      description: "Test",
      column: "triage" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await Promise.all([
      triage.specifyTask(task("KB-001")),
      triage.specifyTask(task("KB-002")),
      triage.specifyTask(task("KB-003")),
    ]);

    expect(maxConcurrent).toBe(1);
    expect(sem.activeCount).toBe(0);
  });

  it("does not set status 'specifying' until semaphore slot is acquired", async () => {
    const sem = new AgentSemaphore(1);
    const store = createMockStore();

    // Acquire the only slot so specifyTask must wait
    await sem.acquire();

    let agentStarted = false;
    mockedCreateHaiAgent.mockImplementation(async () => {
      agentStarted = true;
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
        },
      } as any;
    });

    const triage = new TriageProcessor(store, "/tmp/test", { semaphore: sem });

    const task = {
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Start specifyTask — it will queue on the semaphore
    const specPromise = triage.specifyTask(task);
    await new Promise((r) => setTimeout(r, 20));

    // While queued, status should NOT have been set to "specifying"
    const specifyingCalls = store.updateTask.mock.calls.filter(
      (c: any[]) => c[1]?.status === "specifying",
    );
    expect(specifyingCalls).toHaveLength(0);
    expect(agentStarted).toBe(false);

    // Release the slot — now specifyTask should proceed
    sem.release();
    await specPromise;

    // Now status should have been set to "specifying"
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: "specifying" });
    expect(agentStarted).toBe(true);
  });
});

describe("TriageProcessor poll re-entrance guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prevents overlapping poll() calls while discovery is in progress", async () => {
    let resolveListTasks: (() => void) | undefined;
    const store = createMockStore([]);
    // Make listTasks slow so the first poll is still in the discovery phase
    // when the second poll fires
    store.listTasks.mockImplementation(
      () =>
        new Promise<any[]>((resolve) => {
          resolveListTasks = () => resolve([]);
        }),
    );

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;

    // Start first poll (will block in listTasks)
    const poll1 = (triage as any).poll();
    // Allow microtasks to run so poll1 enters the try block
    await new Promise((r) => setTimeout(r, 10));

    // Start second poll — should return immediately due to guard
    const poll2 = (triage as any).poll();
    await poll2;

    // listTasks should only have been called once (first poll)
    expect(store.listTasks).toHaveBeenCalledTimes(1);

    // Resolve listTasks to let the first poll finish
    resolveListTasks?.();
    await poll1;
  });

  it("allows a new poll() after the previous one completes", async () => {
    const store = createMockStore([]);

    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;

    await (triage as any).poll();
    await (triage as any).poll();

    // Both polls should have called listTasks (sequentially, guard released)
    expect(store.listTasks).toHaveBeenCalledTimes(2);
  });
});

describe("TriageProcessor concurrent dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches multiple triage tasks concurrently in a single poll cycle", async () => {
    const tasks = [
      { id: "KB-001", title: "T1", description: "T1", column: "triage" as const, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: "KB-002", title: "T2", description: "T2", column: "triage" as const, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: "KB-003", title: "T3", description: "T3", column: "triage" as const, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ];
    const store = createMockStore(tasks);

    // Track which tasks are concurrently in-flight
    let concurrent = 0;
    let maxConcurrent = 0;
    const resolvers: (() => void)[] = [];

    mockedCreateHaiAgent.mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            await new Promise<void>((r) => resolvers.push(r));
            concurrent--;
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const sem = new AgentSemaphore(3); // Allow all 3 tasks to run concurrently
    const triage = new TriageProcessor(store, "/tmp/test", { semaphore: sem });
    (triage as any).running = true;

    // poll() should return quickly (non-blocking dispatch)
    await (triage as any).poll();

    // All 3 tasks should have been dispatched concurrently
    await new Promise((r) => setTimeout(r, 50));
    expect(maxConcurrent).toBe(3);
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(3);

    // Resolve all agents
    resolvers.forEach((r) => r());
    await new Promise((r) => setTimeout(r, 50));
  });

  it("polling flag resets before specifyTask calls finish", async () => {
    const tasks = [
      { id: "KB-001", title: "T1", description: "T1", column: "triage" as const, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ];
    const store = createMockStore(tasks);

    let resolveAgent: (() => void) | undefined;
    mockedCreateHaiAgent.mockImplementation(async () => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(
            () => new Promise<void>((r) => { resolveAgent = r; }),
          ),
          dispose: vi.fn(),
        },
      } as any;
    });

    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;

    // poll() should return quickly even though specifyTask is still running
    await (triage as any).poll();

    // polling flag should be false (reset) even though the agent is still working
    expect((triage as any).polling).toBe(false);

    // Resolve the agent to clean up
    resolveAgent?.();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("semaphore still limits actual concurrency across concurrent dispatches", async () => {
    const tasks = [
      { id: "KB-001", title: "T1", description: "T1", column: "triage" as const, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: "KB-002", title: "T2", description: "T2", column: "triage" as const, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: "KB-003", title: "T3", description: "T3", column: "triage" as const, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ];
    const store = createMockStore(tasks);

    let concurrent = 0;
    let maxConcurrent = 0;
    const resolvers: (() => void)[] = [];

    mockedCreateHaiAgent.mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            await new Promise<void>((r) => resolvers.push(r));
            concurrent--;
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const sem = new AgentSemaphore(1); // Only 1 slot
    const triage = new TriageProcessor(store, "/tmp/test", { semaphore: sem });
    (triage as any).running = true;

    // poll() dispatches all 3 but semaphore only allows 1 at a time
    await (triage as any).poll();
    await new Promise((r) => setTimeout(r, 50));

    // Only 1 agent should be running at a time
    expect(maxConcurrent).toBe(1);
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);

    // Resolve first, second gets its slot
    resolvers[0]();
    await new Promise((r) => setTimeout(r, 50));
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1);

    // Resolve second, third gets its slot
    resolvers[1]();
    await new Promise((r) => setTimeout(r, 50));
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(3);
    expect(maxConcurrent).toBe(1);

    // Resolve third
    resolvers[2]();
    await new Promise((r) => setTimeout(r, 50));
    expect(sem.activeCount).toBe(0);
  });

  it("subsequent polls can discover new triage tasks while prior dispatches are still running", async () => {
    const task1 = { id: "KB-001", title: "T1", description: "T1", column: "triage" as const, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const task2 = { id: "KB-002", title: "T2", description: "T2", column: "triage" as const, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const store = createMockStore([task1]);

    const resolvers: (() => void)[] = [];
    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(
          () => new Promise<void>((r) => resolvers.push(r)),
        ),
        dispose: vi.fn(),
      },
    } as any));

    const sem = new AgentSemaphore(5);
    const triage = new TriageProcessor(store, "/tmp/test", { semaphore: sem });
    (triage as any).running = true;

    // First poll dispatches KB-001
    await (triage as any).poll();
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);

    // A new task arrives — second poll should discover it
    store.listTasks.mockResolvedValue([task1, task2]);

    // Second poll runs (polling flag already reset) — KB-001 is in processing set,
    // so only KB-002 is dispatched
    await (triage as any).poll();
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(2);

    // Clean up
    resolvers.forEach((r) => r());
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe("TriageProcessor dynamic poll interval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes poll interval when settings.pollIntervalMs changes", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 10000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });

    const triage = new TriageProcessor(store, "/tmp/test");

    // Simulate start state
    (triage as any).running = true;
    (triage as any).activePollMs = 10000;
    (triage as any).pollInterval = setInterval(() => {}, 10000);

    // First poll — same interval, no change
    await (triage as any).poll();
    expect((triage as any).activePollMs).toBe(10000);

    // Change pollIntervalMs in settings
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 3000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });

    await (triage as any).poll();
    expect((triage as any).activePollMs).toBe(3000);

    // Clean up
    triage.stop();
  });
});

describe("TriageProcessor paused tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips paused triage tasks in poll()", async () => {
    const pausedTask = {
      id: "KB-001",
      title: "Paused",
      description: "Paused task",
      column: "triage" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      paused: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store = createMockStore([pausedTask]);

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;
    await (triage as any).poll();

    // Agent should never be created for a paused task
    expect(mockedCreateHaiAgent).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("processes non-paused triage tasks normally", async () => {
    const normalTask = {
      id: "KB-002",
      title: "Normal",
      description: "Normal task",
      column: "triage" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store = createMockStore([normalTask]);

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;
    await (triage as any).poll();
    // Allow dispatched specifyTask to run (non-blocking dispatch)
    await new Promise((r) => setTimeout(r, 50));

    // Agent should be created for a non-paused task
    expect(store.updateTask).toHaveBeenCalledWith("KB-002", { status: "specifying" });
  });
});

describe("TriageProcessor globalPause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not specify any tasks when globalPause is true", async () => {
    const triageTask = {
      id: "KB-001",
      title: "Test",
      description: "Test task",
      column: "triage" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store = createMockStore([triageTask]);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      globalPause: true,
    });

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;
    await (triage as any).poll();

    // Agent should never be created when globally paused
    expect(mockedCreateHaiAgent).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("resumes triage when globalPause is toggled back to false", async () => {
    const triageTask = {
      id: "KB-002",
      title: "Normal",
      description: "Normal task",
      column: "triage" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store = createMockStore([triageTask]);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      globalPause: true,
    });

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;

    // First poll — paused, nothing happens
    await (triage as any).poll();
    expect(mockedCreateHaiAgent).not.toHaveBeenCalled();

    // Toggle globalPause off
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      globalPause: false,
    });

    // Second poll — should process tasks
    await (triage as any).poll();
    // Allow dispatched specifyTask to run (non-blocking dispatch)
    await new Promise((r) => setTimeout(r, 50));
    expect(store.updateTask).toHaveBeenCalledWith("KB-002", { status: "specifying" });
  });

  it("logs once when entering global pause state", async () => {
    const store = createMockStore([]);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      globalPause: true,
    });

    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await (triage as any).poll();
    await (triage as any).poll();
    await (triage as any).poll();

    const pauseMessages = logSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("Global pause active"),
    );
    expect(pauseMessages).toHaveLength(1);
    logSpy.mockRestore();
  });
});

describe("TriageProcessor immediate resume on unpause via settings:updated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls poll() immediately when globalPause transitions from true to false", async () => {
    const triageTask = {
      id: "KB-001",
      title: "Test",
      description: "Test task",
      column: "triage" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store = createMockStore([triageTask]);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      globalPause: false,
    });

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;

    // Fire the settings:updated event: true → false
    store._trigger("settings:updated", {
      settings: { globalPause: false },
      previous: { globalPause: true },
    });

    // poll() is async, give it time to process
    await new Promise((r) => setTimeout(r, 50));

    // poll() should have been called → triage task processed
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: "specifying" });
  });

  it("does NOT call poll() when globalPause stays false (false → false)", async () => {
    const store = createMockStore([]);
    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;

    // Fire the settings:updated event: false → false
    store._trigger("settings:updated", {
      settings: { globalPause: false },
      previous: { globalPause: false },
    });

    await new Promise((r) => setTimeout(r, 50));

    // poll() should NOT have been called
    expect(store.listTasks).not.toHaveBeenCalled();
  });

  it("does NOT call poll() when globalPause stays true (true → true)", async () => {
    const store = createMockStore([]);
    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;

    // Fire the settings:updated event: true → true
    store._trigger("settings:updated", {
      settings: { globalPause: true },
      previous: { globalPause: true },
    });

    await new Promise((r) => setTimeout(r, 50));

    // poll() should NOT have been called
    expect(store.listTasks).not.toHaveBeenCalled();
  });

  it("does NOT call poll() when processor is not running", async () => {
    const store = createMockStore([]);
    const triage = new TriageProcessor(store, "/tmp/test");
    // running = false (default)

    // Fire the settings:updated event: true → false
    store._trigger("settings:updated", {
      settings: { globalPause: false },
      previous: { globalPause: true },
    });

    await new Promise((r) => setTimeout(r, 50));

    // poll() should NOT have been called since processor is not running
    expect(store.listTasks).not.toHaveBeenCalled();
  });
});

describe("TriageProcessor enginePaused (soft pause)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not specify any tasks when enginePaused is true", async () => {
    const triageTask = {
      id: "KB-001",
      title: "Test",
      description: "Test task",
      column: "triage" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store = createMockStore([triageTask]);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      enginePaused: true,
    });

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;
    await (triage as any).poll();

    // Agent should never be created when engine is soft-paused
    expect(mockedCreateHaiAgent).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("resumes triage when enginePaused is toggled back to false", async () => {
    const triageTask = {
      id: "KB-002",
      title: "Normal",
      description: "Normal task",
      column: "triage" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store = createMockStore([triageTask]);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      enginePaused: true,
    });

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;

    // First poll — engine paused, nothing happens
    await (triage as any).poll();
    expect(mockedCreateHaiAgent).not.toHaveBeenCalled();

    // Toggle enginePaused off
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      enginePaused: false,
    });

    // Second poll — should process tasks
    await (triage as any).poll();
    await new Promise((r) => setTimeout(r, 50));
    expect(store.updateTask).toHaveBeenCalledWith("KB-002", { status: "specifying" });
  });

  it("calls poll() immediately when enginePaused transitions from true to false", async () => {
    const triageTask = {
      id: "KB-001",
      title: "Test",
      description: "Test task",
      column: "triage" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store = createMockStore([triageTask]);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      enginePaused: false,
    });

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;

    // Fire the settings:updated event: enginePaused true → false
    store._trigger("settings:updated", {
      settings: { enginePaused: false },
      previous: { enginePaused: true },
    });

    await new Promise((r) => setTimeout(r, 50));

    // poll() should have been called → triage task processed
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: "specifying" });
  });

  it("does NOT call poll() when enginePaused stays false (false → false)", async () => {
    const store = createMockStore([]);
    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;

    store._trigger("settings:updated", {
      settings: { enginePaused: false },
      previous: { enginePaused: false },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(store.listTasks).not.toHaveBeenCalled();
  });
});

describe("buildSpecificationPrompt", () => {
  it("includes project commands when testCommand is set", () => {
    const task = createMockTaskDetail();
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      testCommand: "pnpm test",
    });

    expect(result).toContain("## Project Commands");
    expect(result).toContain("**Test:** `pnpm test`");
    expect(result).toContain("Use these exact commands");
  });

  it("includes project commands when buildCommand is set", () => {
    const task = createMockTaskDetail();
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      buildCommand: "pnpm build",
    });

    expect(result).toContain("## Project Commands");
    expect(result).toContain("**Build:** `pnpm build`");
  });

  it("includes both commands when both are set", () => {
    const task = createMockTaskDetail();
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      testCommand: "npm test",
      buildCommand: "npm run build",
    });

    expect(result).toContain("**Test:** `npm test`");
    expect(result).toContain("**Build:** `npm run build`");
  });

  it("omits project commands section when neither command is set", () => {
    const task = createMockTaskDetail();
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });

    expect(result).not.toContain("## Project Commands");
  });

  it("omits project commands section when settings is undefined", () => {
    const task = createMockTaskDetail();
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md");

    expect(result).not.toContain("## Project Commands");
  });

  it("includes text attachment content in fenced code block", () => {
    const task = createMockTaskDetail();
    const attachmentContents: AttachmentContent[] = [
      { originalName: "error.log", mimeType: "text/plain", text: "ERROR: something broke\nStack trace here" },
    ];
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", undefined, attachmentContents);

    expect(result).toContain("## Attachments");
    expect(result).toContain("### error.log (text/plain)");
    expect(result).toContain("```\nERROR: something broke\nStack trace here\n```");
  });

  it("includes image attachment reference in prompt", () => {
    const task = createMockTaskDetail();
    const attachmentContents: AttachmentContent[] = [
      { originalName: "screenshot.png", mimeType: "image/png", text: null },
    ];
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", undefined, attachmentContents);

    expect(result).toContain("## Attachments");
    expect(result).toContain("**screenshot.png** (image/png)");
    expect(result).toContain("included as image below");
  });

  it("includes both image and text attachments", () => {
    const task = createMockTaskDetail();
    const attachmentContents: AttachmentContent[] = [
      { originalName: "screenshot.png", mimeType: "image/png", text: null },
      { originalName: "config.json", mimeType: "application/json", text: '{"key": "value"}' },
    ];
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", undefined, attachmentContents);

    expect(result).toContain("**screenshot.png** (image/png)");
    expect(result).toContain("### config.json (application/json)");
    expect(result).toContain('{"key": "value"}');
  });

  it("omits attachments section when no attachments", () => {
    const task = createMockTaskDetail();
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", undefined, []);

    expect(result).not.toContain("## Attachments");
  });

  it("omits attachments section when attachmentContents is undefined", () => {
    const task = createMockTaskDetail();
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md");

    expect(result).not.toContain("## Attachments");
  });
});

describe("TRIAGE_SYSTEM_PROMPT and task_get tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("system prompt contains dependency awareness instructions", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test");
    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const callArgs = mockedCreateHaiAgent.mock.calls[0][0];
    const systemPrompt = callArgs.systemPrompt as string;
    expect(systemPrompt).toContain("## Dependency awareness");
    expect(systemPrompt).toContain("call `task_get` on that task ID to read its PROMPT.md");
  });

  it("task_get tool description mentions reading dependency specs", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test");
    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const callArgs = mockedCreateHaiAgent.mock.calls[0][0];
    const tools = callArgs.customTools as any[];
    const taskGetTool = tools.find((t: any) => t.name === "task_get");
    expect(taskGetTool).toBeDefined();
    expect(taskGetTool.description).toContain("read dependency task specs");
  });
});

function createEnoentError(path = "/fake/path"): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, open '${path}'`),
    { code: "ENOENT", errno: -2, syscall: "open" },
  );
}

const dummyTask = {
  id: "KB-099",
  title: "Deleted task",
  description: "This task was deleted",
  column: "triage" as const,
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("TriageProcessor deleted task handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles ENOENT from updateTask gracefully without calling onSpecifyError", async () => {
    const store = createMockStore();
    store.updateTask.mockRejectedValue(createEnoentError());

    const onError = vi.fn();
    const triage = new TriageProcessor(store, "/tmp/test", {
      onSpecifyError: onError,
    });

    // Should not throw
    await triage.specifyTask(dummyTask);

    expect(onError).not.toHaveBeenCalled();
    // updateTask was called once (the "specifying" call that threw)
    expect(store.updateTask).toHaveBeenCalledTimes(1);
  });

  it("handles ENOENT from getTask gracefully", async () => {
    const store = createMockStore();
    store.updateTask.mockResolvedValue({});
    store.getTask.mockRejectedValue(createEnoentError());

    const onError = vi.fn();
    const triage = new TriageProcessor(store, "/tmp/test", {
      onSpecifyError: onError,
    });

    await triage.specifyTask(dummyTask);

    expect(onError).not.toHaveBeenCalled();
    // getTask throws ENOENT before updateTask(status: "specifying") is reached
    // (status update moved inside agentWork, after semaphore acquisition)
    expect(store.updateTask).toHaveBeenCalledTimes(0);
  });

  it("cleans up processing Set on ENOENT so task is not stuck", async () => {
    const store = createMockStore();
    // getTask throws ENOENT (task deleted between poll and specify)
    store.getTask.mockRejectedValueOnce(createEnoentError());

    const triage = new TriageProcessor(store, "/tmp/test", {});

    // First call — ENOENT
    await triage.specifyTask(dummyTask);

    // Second call with same task should NOT short-circuit from processing guard.
    // Reset mock to succeed and set up agent mock for the retry path.
    store.updateTask.mockResolvedValue({});
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    await triage.specifyTask(dummyTask);

    // If processing Set was cleaned up, updateTask will be called again for "specifying"
    expect(store.updateTask).toHaveBeenCalledWith("KB-099", { status: "specifying" });
    expect(mockedCreateHaiAgent).toHaveBeenCalled();
  });
});

describe("TriageProcessor agent log persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs text deltas to store.appendAgentLog", async () => {
    const store = createMockStore();
    let capturedOnText: ((delta: string) => void) | undefined;

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOnText = opts.onText;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate text deltas from the agent
            capturedOnText?.("Hello ");
            capturedOnText?.("world");
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const triage = new TriageProcessor(store, "/tmp/test", {});
    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Text buffer is flushed in finally block
    expect(store.appendAgentLog).toHaveBeenCalledWith("KB-001", "Hello world", "text", undefined, "triage");
  });

  it("logs tool invocations to store.appendAgentLog", async () => {
    const store = createMockStore();
    let capturedOnToolStart: ((name: string, args: any) => void) | undefined;

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOnToolStart = opts.onToolStart;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            capturedOnToolStart?.("Read", { path: "foo.ts" });
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const triage = new TriageProcessor(store, "/tmp/test", {});
    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(store.appendAgentLog).toHaveBeenCalledWith("KB-001", "Read", "tool", "foo.ts", "triage");
  });

  it("still fires onAgentText callback alongside logging", async () => {
    const store = createMockStore();
    const onAgentText = vi.fn();
    let capturedOnText: ((delta: string) => void) | undefined;

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOnText = opts.onText;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            capturedOnText?.("hi");
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const triage = new TriageProcessor(store, "/tmp/test", { onAgentText });
    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(onAgentText).toHaveBeenCalledWith("KB-001", "hi");
    expect(store.appendAgentLog).toHaveBeenCalledWith("KB-001", "hi", "text", undefined, "triage");
  });
});

describe("TriageProcessor dependency parsing", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "kb-triage-dep-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const makeTask = (id = "KB-001") => ({
    id,
    title: "Test",
    description: "Test task",
    column: "triage" as const,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  async function writePromptMd(rootDir: string, taskId: string, content: string) {
    const dir = join(rootDir, ".kb", "tasks", taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), content);
  }

  it("calls parseDependenciesFromPrompt and persists deps via updateTask before moveTask", async () => {
    const store = createMockStore();
    store.parseDependenciesFromPrompt.mockResolvedValue(["KB-010", "KB-020"]);

    const promptContent = `# KB-001: Test Task

**Size:** M

## Review Level: 2 (Plan and Code)

## Dependencies

- **Task:** KB-010 (first dep)
- **Task:** KB-020 (second dep)

## Steps

### Step 0: Preflight
`;
    await writePromptMd(tmpDir, "KB-001", promptContent);

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, tmpDir);
    await triage.specifyTask(makeTask());

    // Verify parseDependenciesFromPrompt was called
    expect(store.parseDependenciesFromPrompt).toHaveBeenCalledWith("KB-001");

    // Verify updateTask was called with dependencies, size, and reviewLevel
    const updateCalls = store.updateTask.mock.calls;
    // First call is { status: "specifying" } (inside agentWork), second is the post-parse call
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);
    const postParseCAll = updateCalls[1];
    expect(postParseCAll[0]).toBe("KB-001");
    expect(postParseCAll[1]).toMatchObject({
      status: null,
      dependencies: ["KB-010", "KB-020"],
      size: "M",
      reviewLevel: 2,
    });

    // Verify moveTask was called after updateTask
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
  });

  it("does not include dependencies in updateTask when parseDependenciesFromPrompt returns empty", async () => {
    const store = createMockStore();
    store.parseDependenciesFromPrompt.mockResolvedValue([]);

    const promptContent = `# KB-001: Test Task

## Dependencies

- **None**

## Steps
`;
    await writePromptMd(tmpDir, "KB-001", promptContent);

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, tmpDir);
    await triage.specifyTask(makeTask());

    // The post-parse updateTask call should not include dependencies
    const updateCalls = store.updateTask.mock.calls;
    const postParseCall = updateCalls[1];
    expect(postParseCall[1]).not.toHaveProperty("dependencies");
    expect(postParseCall[1]).toHaveProperty("status", null);

    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
  });

  it("extracts size and reviewLevel from PROMPT.md front-matter", async () => {
    const store = createMockStore();
    store.parseDependenciesFromPrompt.mockResolvedValue([]);

    const promptContent = `# KB-001: Test Task

**Size:** L

## Review Level: 3 (Full)

## Dependencies

- **None**

## Steps
`;
    await writePromptMd(tmpDir, "KB-001", promptContent);

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, tmpDir);
    await triage.specifyTask(makeTask());

    const updateCalls = store.updateTask.mock.calls;
    const postParseCall = updateCalls[1];
    expect(postParseCall[1]).toMatchObject({
      status: null,
      size: "L",
      reviewLevel: 3,
    });
  });
});

// ── Usage limit detection in triage ──────────────────────────────────

import { UsageLimitPauser } from "./usage-limit-detector.js";

describe("TriageProcessor usage limit detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("triggers global pause when triage catches a usage-limit error", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    mockedCreateHaiAgent.mockRejectedValue(new Error("rate_limit_error: Rate limit exceeded"));

    const onError = vi.fn();
    const triage = new TriageProcessor(store, "/tmp/test", {
      onSpecifyError: onError,
      usageLimitPauser: pauser,
    });

    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(onUsageLimitHitSpy).toHaveBeenCalledWith(
      "triage",
      "KB-001",
      "rate_limit_error: Rate limit exceeded",
    );
    expect(store.updateSettings).toHaveBeenCalledWith({ globalPause: true });
    // Error callback should still fire
    expect(onError).toHaveBeenCalled();
  });

  it("triggers global pause when session.prompt() resolves with exhausted-retry error on state.error", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    // session.prompt() resolves normally, but session.state.error is set
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      state: { error: "overloaded_error: Overloaded" },
    };
    mockedCreateHaiAgent.mockResolvedValue({ session: mockSession } as any);

    const onError = vi.fn();
    const triage = new TriageProcessor(store, "/tmp/test", {
      onSpecifyError: onError,
      usageLimitPauser: pauser,
    });

    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // UsageLimitPauser should be called with "triage" agent type
    expect(onUsageLimitHitSpy).toHaveBeenCalledWith(
      "triage",
      "KB-001",
      "overloaded_error: Overloaded",
    );
    // Task status should be cleared (not moved to todo with broken spec)
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: null });
    // onSpecifyError callback should fire
    expect(onError).toHaveBeenCalled();
  });

  it("does NOT trigger global pause for non-usage-limit errors", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    mockedCreateHaiAgent.mockRejectedValue(new Error("connection refused"));

    const onError = vi.fn();
    const triage = new TriageProcessor(store, "/tmp/test", {
      onSpecifyError: onError,
      usageLimitPauser: pauser,
    });

    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(onUsageLimitHitSpy).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it("does NOT trigger global pause for ENOENT errors (deleted tasks)", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    const enoentError = Object.assign(
      new Error("ENOENT: no such file or directory"),
      { code: "ENOENT" },
    );
    store.updateTask.mockRejectedValue(enoentError);

    const onError = vi.fn();
    const triage = new TriageProcessor(store, "/tmp/test", {
      onSpecifyError: onError,
      usageLimitPauser: pauser,
    });

    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(onUsageLimitHitSpy).not.toHaveBeenCalled();
    // ENOENT errors don't call onSpecifyError
    expect(onError).not.toHaveBeenCalled();
  });

  it("works without usageLimitPauser (backward compatible)", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockRejectedValue(new Error("rate_limit_error: Rate limit exceeded"));

    const onError = vi.fn();
    const triage = new TriageProcessor(store, "/tmp/test", {
      onSpecifyError: onError,
    });

    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should not crash — just call onError
    expect(onError).toHaveBeenCalled();
  });
});

describe("TriageProcessor global pause agent kill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disposes active triage sessions when settings:updated fires with globalPause: true", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Trigger global pause while the session is active
          store._trigger("settings:updated", {
            settings: { globalPause: true },
            previous: { globalPause: false },
          });
          throw new Error("Session terminated");
        }),
        dispose: disposeFn,
      },
    } as any));

    const triage = new TriageProcessor(store, "/tmp/test");

    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // dispose is called by the global pause listener and again in finally
    expect(disposeFn).toHaveBeenCalled();
    // Status should be cleared (not reported as error)
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: null });
  });

  it("disposed triage tasks have their status cleared and are not reported as error", async () => {
    const store = createMockStore();
    const onError = vi.fn();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          store._trigger("settings:updated", {
            settings: { globalPause: true },
            previous: { globalPause: false },
          });
          throw new Error("Session terminated");
        }),
        dispose: vi.fn(),
      },
    } as any));

    const triage = new TriageProcessor(store, "/tmp/test", { onSpecifyError: onError });

    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // onSpecifyError should NOT be called for global-pause aborted tasks
    expect(onError).not.toHaveBeenCalled();
    // Status should be cleared
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: null });
  });

  it("non-pause errors still report via onSpecifyError", async () => {
    const store = createMockStore();
    const onError = vi.fn();

    mockedCreateHaiAgent.mockImplementation(async () => {
      throw new Error("Agent creation failed");
    });

    const triage = new TriageProcessor(store, "/tmp/test", { onSpecifyError: onError });

    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // onSpecifyError should be called for non-pause errors
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "KB-001" }),
      expect.any(Error),
    );
  });
});

describe("TriageProcessor enginePaused agent termination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("terminates active triage sessions when enginePaused transitions false→true", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Trigger engine pause while the session is active
          store._trigger("settings:updated", {
            settings: { enginePaused: true },
            previous: { enginePaused: false },
          });
          throw new Error("Session terminated");
        }),
        dispose: disposeFn,
      },
    } as any));

    const triage = new TriageProcessor(store, "/tmp/test");

    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // dispose is called by the engine pause listener and again in finally
    expect(disposeFn).toHaveBeenCalled();
  });

  it("clears specifying status on terminated tasks", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          store._trigger("settings:updated", {
            settings: { enginePaused: true },
            previous: { enginePaused: false },
          });
          throw new Error("Session terminated");
        }),
        dispose: vi.fn(),
      },
    } as any));

    const triage = new TriageProcessor(store, "/tmp/test");

    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Status should be cleared (not reported as error)
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: null });
  });

  it("does not report errors for engine-pause-aborted tasks", async () => {
    const store = createMockStore();
    const onError = vi.fn();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          store._trigger("settings:updated", {
            settings: { enginePaused: true },
            previous: { enginePaused: false },
          });
          throw new Error("Session terminated");
        }),
        dispose: vi.fn(),
      },
    } as any));

    const triage = new TriageProcessor(store, "/tmp/test", { onSpecifyError: onError });

    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // onSpecifyError should NOT be called for engine-pause aborted tasks
    expect(onError).not.toHaveBeenCalled();
    // Status should be cleared
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: null });
  });
});

// ── Triage spec review loop tests ──────────────────────────────────

describe("TriageProcessor review_spec tool", () => {
  let tmpDir: string;

  const makeTask = (id = "KB-001") => ({
    id,
    title: "Test",
    description: "Test task",
    column: "triage" as const,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "kb-triage-review-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writePromptMd(rootDir: string, taskId: string, content: string) {
    const dir = join(rootDir, ".kb", "tasks", taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), content);
  }

  it("registers review_spec as a custom tool on createKbAgent calls", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
      },
    } as any);

    const triage = new TriageProcessor(store, tmpDir);
    await triage.specifyTask(makeTask());

    expect(mockedCreateHaiAgent).toHaveBeenCalledOnce();
    const callArgs = mockedCreateHaiAgent.mock.calls[0][0];
    const tools = callArgs.customTools as any[];
    const reviewTool = tools.find((t: any) => t.name === "review_spec");
    expect(reviewTool).toBeDefined();
    expect(reviewTool.name).toBe("review_spec");
    expect(reviewTool.description).toContain("reviewer");
  });

  it("system prompt contains instructions for calling review_spec", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
      },
    } as any);

    const triage = new TriageProcessor(store, tmpDir);
    await triage.specifyTask(makeTask());

    const callArgs = mockedCreateHaiAgent.mock.calls[0][0];
    const systemPrompt = callArgs.systemPrompt as string;
    expect(systemPrompt).toContain("review_spec()");
    expect(systemPrompt).toContain("APPROVE");
    expect(systemPrompt).toContain("REVISE");
    expect(systemPrompt).toContain("RETHINK");
  });

  it("when reviewer returns APPROVE, task proceeds to todo normally", async () => {
    const store = createMockStore();
    store.parseDependenciesFromPrompt.mockResolvedValue([]);

    const promptContent = "# Task: KB-001\n\n**Size:** S\n\n## Review Level: 0\n\n## Steps\n";
    await writePromptMd(tmpDir, "KB-001", promptContent);

    let reviewSpecTool: any;
    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      reviewSpecTool = opts.customTools?.find((t: any) => t.name === "review_spec");
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate the agent calling review_spec
            if (reviewSpecTool) {
              await reviewSpecTool.execute("call-1", {});
            }
          }),
          dispose: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        },
      } as any;
    });

    mockedReviewStep.mockResolvedValue({
      verdict: "APPROVE",
      review: "Good spec",
      summary: "Looks good",
    });

    const triage = new TriageProcessor(store, tmpDir);
    await triage.specifyTask(makeTask());

    // Task should move to todo
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
  });

  it("review_spec tool calls reviewStep with reviewType spec", async () => {
    const store = createMockStore();
    store.parseDependenciesFromPrompt.mockResolvedValue([]);

    const promptContent = "# Task: KB-001\n\n**Size:** S\n\n## Review Level: 0\n\n## Steps\n";
    await writePromptMd(tmpDir, "KB-001", promptContent);

    let reviewSpecTool: any;
    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      reviewSpecTool = opts.customTools?.find((t: any) => t.name === "review_spec");
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (reviewSpecTool) {
              await reviewSpecTool.execute("call-1", {});
            }
          }),
          dispose: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        },
      } as any;
    });

    mockedReviewStep.mockResolvedValue({
      verdict: "APPROVE",
      review: "Good spec",
      summary: "Looks good",
    });

    const triage = new TriageProcessor(store, tmpDir);
    await triage.specifyTask(makeTask());

    expect(mockedReviewStep).toHaveBeenCalledTimes(1);
    const reviewArgs = mockedReviewStep.mock.calls[0];
    expect(reviewArgs[0]).toBe(tmpDir); // cwd = rootDir
    expect(reviewArgs[1]).toBe("KB-001"); // taskId
    expect(reviewArgs[2]).toBe(0); // stepNumber
    expect(reviewArgs[3]).toBe("Specification"); // stepName
    expect(reviewArgs[4]).toBe("spec"); // reviewType
    expect(reviewArgs[5]).toBe(promptContent); // promptContent
  });

  it("logs review verdict via store.logEntry", async () => {
    const store = createMockStore();
    store.parseDependenciesFromPrompt.mockResolvedValue([]);

    const promptContent = "# Task: KB-001\n\n**Size:** S\n\n## Steps\n";
    await writePromptMd(tmpDir, "KB-001", promptContent);

    let reviewSpecTool: any;
    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      reviewSpecTool = opts.customTools?.find((t: any) => t.name === "review_spec");
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (reviewSpecTool) {
              await reviewSpecTool.execute("call-1", {});
            }
          }),
          dispose: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        },
      } as any;
    });

    mockedReviewStep.mockResolvedValue({
      verdict: "APPROVE",
      review: "Good spec",
      summary: "Looks good",
    });

    const triage = new TriageProcessor(store, tmpDir);
    await triage.specifyTask(makeTask());

    // Check logEntry calls for review-related entries
    const logCalls = store.logEntry.mock.calls;
    const reviewRequestLog = logCalls.find((c: any[]) => c[1] === "Spec review requested");
    expect(reviewRequestLog).toBeDefined();

    const verdictLog = logCalls.find((c: any[]) => c[1] === "Spec review: APPROVE");
    expect(verdictLog).toBeDefined();
    expect(verdictLog![2]).toBe("Looks good"); // summary as outcome
  });

  it("reviewer failure returns UNAVAILABLE to the agent", async () => {
    const store = createMockStore();
    store.parseDependenciesFromPrompt.mockResolvedValue([]);

    const promptContent = "# Task: KB-001\n\n**Size:** S\n\n## Steps\n";
    await writePromptMd(tmpDir, "KB-001", promptContent);

    let reviewResult: any;
    let reviewSpecTool: any;
    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      reviewSpecTool = opts.customTools?.find((t: any) => t.name === "review_spec");
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (reviewSpecTool) {
              reviewResult = await reviewSpecTool.execute("call-1", {});
            }
          }),
          dispose: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        },
      } as any;
    });

    mockedReviewStep.mockRejectedValue(new Error("API connection failed"));

    const triage = new TriageProcessor(store, tmpDir);
    await triage.specifyTask(makeTask());

    expect(reviewResult.content[0].text).toContain("UNAVAILABLE");
    expect(reviewResult.content[0].text).toContain("API connection failed");
  });

  it("returns UNAVAILABLE when PROMPT.md file does not exist", async () => {
    const store = createMockStore();

    let reviewResult: any;
    let reviewSpecTool: any;
    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      reviewSpecTool = opts.customTools?.find((t: any) => t.name === "review_spec");
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (reviewSpecTool) {
              reviewResult = await reviewSpecTool.execute("call-1", {});
            }
          }),
          dispose: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        },
      } as any;
    });

    const triage = new TriageProcessor(store, tmpDir);
    await triage.specifyTask(makeTask());

    expect(reviewResult.content[0].text).toContain("UNAVAILABLE");
    expect(reviewResult.content[0].text).toContain("not found or empty");
  });

  it("post-session REVISE gate prevents moving to todo when last verdict is REVISE", async () => {
    const store = createMockStore();
    store.parseDependenciesFromPrompt.mockResolvedValue([]);

    const promptContent = "# Task: KB-001\n\n**Size:** S\n\n## Steps\n";
    await writePromptMd(tmpDir, "KB-001", promptContent);

    let reviewSpecTool: any;
    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      reviewSpecTool = opts.customTools?.find((t: any) => t.name === "review_spec");
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate the agent calling review_spec but getting REVISE and then stopping
            if (reviewSpecTool) {
              await reviewSpecTool.execute("call-1", {});
            }
            // Agent finishes without APPROVE
          }),
          dispose: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        },
      } as any;
    });

    mockedReviewStep.mockResolvedValue({
      verdict: "REVISE",
      review: "Missing test requirements",
      summary: "Spec needs work",
    });

    const triage = new TriageProcessor(store, tmpDir);
    await triage.specifyTask(makeTask());

    // Task should NOT move to todo
    expect(store.moveTask).not.toHaveBeenCalled();
    // Status should be cleared
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: null });
    // Should log the REVISE gate
    const logCalls = store.logEntry.mock.calls;
    const reviseGateLog = logCalls.find((c: any[]) =>
      typeof c[1] === "string" && c[1].includes("not approved"),
    );
    expect(reviseGateLog).toBeDefined();
  });

  it("REVISE tool response includes review feedback", async () => {
    const store = createMockStore();

    const promptContent = "# Task: KB-001\n\n**Size:** S\n\n## Steps\n";
    await writePromptMd(tmpDir, "KB-001", promptContent);

    let reviewResult: any;
    let reviewSpecTool: any;
    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      reviewSpecTool = opts.customTools?.find((t: any) => t.name === "review_spec");
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (reviewSpecTool) {
              reviewResult = await reviewSpecTool.execute("call-1", {});
            }
          }),
          dispose: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        },
      } as any;
    });

    mockedReviewStep.mockResolvedValue({
      verdict: "REVISE",
      review: "Missing test requirements\n\nAdd real tests.",
      summary: "Spec needs work",
    });

    const triage = new TriageProcessor(store, tmpDir);
    await triage.specifyTask(makeTask());

    expect(reviewResult.content[0].text).toContain("REVISE");
    expect(reviewResult.content[0].text).toContain("Missing test requirements");
    expect(reviewResult.content[0].text).toContain("call review_spec() again");
  });
});
