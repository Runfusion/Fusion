import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { GridlockDetector } from "../gridlock-detector.js";

function createTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: "desc",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    log: [],
    ...overrides,
  };
}

function createSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: true,
    autoMerge: true,
    overlapIgnorePaths: [],
    ...overrides,
  } as Settings;
}

describe("GridlockDetector", () => {
  let tasks: Task[];
  let settings: Settings;
  let scopes: Record<string, string[]>;
  let onGridlock: ReturnType<typeof vi.fn>;
  let store: TaskStore;
  let detector: GridlockDetector;

  beforeEach(() => {
    tasks = [];
    settings = createSettings();
    scopes = {};
    onGridlock = vi.fn();
    store = {
      listTasks: vi.fn(async () => tasks),
      getSettings: vi.fn(async () => settings),
      parseFileScopeFromPrompt: vi.fn(async (taskId: string) => scopes[taskId] ?? []),
    } as unknown as TaskStore;
    detector = new GridlockDetector(store, { onGridlock });
  });

  afterEach(() => {
    detector.stop();
  });

  it("detects gridlock when all todo tasks are blocked by dependencies", async () => {
    tasks = [
      createTask("FN-1", { column: "todo", dependencies: ["FN-10"] }),
      createTask("FN-2", { column: "todo", dependencies: ["FN-11"] }),
      createTask("FN-3", { column: "in-progress" }),
      createTask("FN-10", { column: "in-progress" }),
      createTask("FN-11", { column: "in-progress" }),
    ];

    const event = await detector.detectGridlock();

    expect(event).not.toBeNull();
    expect(event?.blockedTaskIds).toEqual(["FN-1", "FN-2"]);
    expect(event?.reasons).toEqual({ "FN-1": "dependency", "FN-2": "dependency" });
    expect(event?.blockingTaskIds).toEqual(["FN-10", "FN-11"]);
    expect(onGridlock).toHaveBeenCalledTimes(1);
  });

  it("detects gridlock when all todo tasks are blocked by file overlap", async () => {
    tasks = [
      createTask("FN-1", { column: "todo" }),
      createTask("FN-2", { column: "todo" }),
      createTask("FN-9", { column: "in-progress" }),
    ];
    scopes = {
      "FN-1": ["packages/core/src/a.ts"],
      "FN-2": ["packages/core/src/b.ts"],
      "FN-9": ["packages/core/src/*"],
    };

    const event = await detector.detectGridlock();

    expect(event?.blockedTaskIds).toEqual(["FN-1", "FN-2"]);
    expect(event?.reasons).toEqual({ "FN-1": "overlap", "FN-2": "overlap" });
    expect(event?.blockingTaskIds).toEqual(["FN-9"]);
  });

  it("does not detect gridlock when there are no schedulable tasks", async () => {
    tasks = [createTask("FN-1", { column: "todo", paused: true }), createTask("FN-2", { column: "in-progress" })];

    const event = await detector.detectGridlock();

    expect(event).toBeNull();
    expect(onGridlock).not.toHaveBeenCalled();
  });

  it("does not detect gridlock when at least one todo task is unblocked", async () => {
    tasks = [
      createTask("FN-1", { column: "todo", dependencies: ["FN-10"] }),
      createTask("FN-2", { column: "todo" }),
      createTask("FN-3", { column: "in-progress" }),
      createTask("FN-10", { column: "todo" }),
    ];

    const event = await detector.detectGridlock();
    expect(event).toBeNull();
  });

  it("deduplicates same blocked task set", async () => {
    tasks = [
      createTask("FN-1", { column: "todo", dependencies: ["FN-10"] }),
      createTask("FN-2", { column: "in-progress" }),
      createTask("FN-10", { column: "in-progress" }),
    ];

    await detector.detectGridlock();
    await detector.detectGridlock();

    expect(onGridlock).toHaveBeenCalledTimes(1);
  });

  it("fires again when blocked task set changes", async () => {
    tasks = [
      createTask("FN-1", { column: "todo", dependencies: ["FN-10"] }),
      createTask("FN-2", { column: "in-progress" }),
      createTask("FN-10", { column: "in-progress" }),
    ];

    await detector.detectGridlock();
    tasks = [
      ...tasks,
      createTask("FN-3", { column: "todo", dependencies: ["FN-10"] }),
    ];
    await detector.detectGridlock();

    expect(onGridlock).toHaveBeenCalledTimes(2);
  });

  it("resets dedup after resolution", async () => {
    tasks = [
      createTask("FN-1", { column: "todo", dependencies: ["FN-10"] }),
      createTask("FN-2", { column: "in-progress" }),
      createTask("FN-10", { column: "in-progress" }),
    ];

    await detector.detectGridlock();
    tasks = [createTask("FN-1", { column: "todo" }), createTask("FN-2", { column: "in-progress" }), createTask("FN-10", { column: "done" })];
    await detector.detectGridlock();

    tasks = [
      createTask("FN-1", { column: "todo", dependencies: ["FN-10"] }),
      createTask("FN-2", { column: "in-progress" }),
      createTask("FN-10", { column: "in-progress" }),
    ];
    await detector.detectGridlock();

    expect(onGridlock).toHaveBeenCalledTimes(2);
  });

  it("respects paused and recovery-backoff tasks as non-schedulable", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    tasks = [
      createTask("FN-1", { column: "todo", paused: true, dependencies: ["FN-9"] }),
      createTask("FN-2", { column: "todo", nextRecoveryAt: future, dependencies: ["FN-9"] }),
      createTask("FN-3", { column: "in-progress" }),
      createTask("FN-9", { column: "todo" }),
    ];

    const event = await detector.detectGridlock();
    expect(event).toBeNull();
  });

  it("respects overlap ignore paths from settings", async () => {
    settings = createSettings({ overlapIgnorePaths: ["docs/"] });
    tasks = [
      createTask("FN-1", { column: "todo" }),
      createTask("FN-2", { column: "in-progress" }),
    ];
    scopes = {
      "FN-1": ["docs/readme.md"],
      "FN-2": ["docs/"],
    };

    const event = await detector.detectGridlock();
    expect(event).toBeNull();
  });
});
