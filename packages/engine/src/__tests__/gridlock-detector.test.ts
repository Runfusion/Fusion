import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { GridlockDetector } from "../gridlock-detector.js";
import type { GridlockEvent } from "../gridlock-detector.js";
import { RENAMED_VOCAB, lifecycleIr } from "./_workflow-vocabulary-fixture.js";

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
  let onGridlock: ReturnType<typeof vi.fn<(event: GridlockEvent) => void>>;
  let onGridlockCleared: ReturnType<typeof vi.fn<() => void>>;
  let store: TaskStore;
  let detector: GridlockDetector;

  beforeEach(() => {
    tasks = [];
    settings = createSettings();
    scopes = {};
    onGridlock = vi.fn();
    onGridlockCleared = vi.fn();
    store = {
      listTasks: vi.fn(async () => tasks),
      getSettings: vi.fn(async () => settings),
      parseFileScopeFromPrompt: vi.fn(async (taskId: string) => scopes[taskId] ?? []),
    } as unknown as TaskStore;
    detector = new GridlockDetector(store, { onGridlock, onGridlockCleared });
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

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-11:05 (batch-engine tail):
  The dependency-satisfaction gate resolved by ROLE. Every other case in this file omits a workflow, so
  `resolveWorkflowIrForTask` degrades to the built-in coding IR and they all assert the LEGACY answer —
  they pass before and after this conversion, and would pass for a broken one too.

  A FALSE ALARM is the failure being fixed: on a renamed board no dependency ever satisfied the three
  literal comparisons, so the detector reported dependency gridlock for tasks that are not blocked and
  `notifyGridlock` paged the operator about it.

  REVERT CHECK, measured: with `dep.column !== "done" && dep.column !== "in-review" && dep.column !==
  "archived"` restored, this fails — a gridlock event is raised naming FN-1 blocked by FN-10.
  */
  it("does not report dependency gridlock when the blocker sits in a RENAMED complete lane", async () => {
    const ir = lifecycleIr(RENAMED_VOCAB, "gridlock-lifecycle");
    store = {
      listTasks: vi.fn(async () => tasks),
      getSettings: vi.fn(async () => settings),
      parseFileScopeFromPrompt: vi.fn(async (taskId: string) => scopes[taskId] ?? []),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "gridlock-lifecycle", stepIds: [] })),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "gridlock-lifecycle", stepIds: [] })),
      getWorkflowDefinition: vi.fn(async (id: string) => (id === "gridlock-lifecycle" ? { ir } : undefined)),
    } as unknown as TaskStore;
    detector = new GridlockDetector(store, { onGridlock, onGridlockCleared });

    tasks = [
      // Schedulable: sits in the renamed HOLD lane, blocked by a card that has SHIPPED.
      createTask("FN-1", { column: RENAMED_VOCAB.hold, dependencies: ["FN-10"] }),
      createTask("FN-10", { column: RENAMED_VOCAB.complete }),
      // Keeps the ACTIVE set non-empty; an empty one is its own early return and would
      // make this pass without the dependency gate ever being consulted.
      createTask("FN-9", { column: RENAMED_VOCAB.wip }),
    ];

    const event = await detector.detectGridlock();

    expect(event).toBeNull();
    expect(onGridlock).not.toHaveBeenCalled();
  });

  it("still reports dependency gridlock when the blocker is mid-flight on a RENAMED board", async () => {
    /*
    Non-vacuous companion: without it, a gate that treated EVERY dependency as satisfied would pass the
    case above. Same renamed board, same shape — only the blocker's lane changes.
    */
    const ir = lifecycleIr(RENAMED_VOCAB, "gridlock-lifecycle");
    store = {
      listTasks: vi.fn(async () => tasks),
      getSettings: vi.fn(async () => settings),
      parseFileScopeFromPrompt: vi.fn(async (taskId: string) => scopes[taskId] ?? []),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "gridlock-lifecycle", stepIds: [] })),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "gridlock-lifecycle", stepIds: [] })),
      getWorkflowDefinition: vi.fn(async (id: string) => (id === "gridlock-lifecycle" ? { ir } : undefined)),
    } as unknown as TaskStore;
    detector = new GridlockDetector(store, { onGridlock, onGridlockCleared });

    tasks = [
      createTask("FN-1", { column: RENAMED_VOCAB.hold, dependencies: ["FN-10"] }),
      createTask("FN-10", { column: RENAMED_VOCAB.wip }),
      createTask("FN-9", { column: RENAMED_VOCAB.wip }),
    ];

    const event = await detector.detectGridlock();

    expect(event?.blockedTaskIds).toEqual(["FN-1"]);
    expect(event?.reasons).toEqual({ "FN-1": "dependency" });
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
    expect(onGridlockCleared).toHaveBeenCalledTimes(1);
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

  it("does not report gridlock for hidden-only overlaps by default", async () => {
    tasks = [
      createTask("FN-1", { column: "todo" }),
      createTask("FN-2", { column: "in-progress" }),
    ];
    scopes = {
      "FN-1": [".fusion/tasks/FN-1/PROMPT.md", "packages/.cache/out.js"],
      "FN-2": [".fusion/tasks/FN-1/PROMPT.md", "packages/.cache/out.js"],
    };

    const event = await detector.detectGridlock();
    expect(event).toBeNull();
    expect(onGridlock).not.toHaveBeenCalled();
  });

  it("reports gridlock for hidden-only overlaps when legacy counting is restored", async () => {
    settings = createSettings({ ignoreHiddenOverlapPaths: false });
    tasks = [
      createTask("FN-1", { column: "todo" }),
      createTask("FN-2", { column: "in-progress" }),
    ];
    scopes = {
      "FN-1": [".fusion/tasks/FN-1/PROMPT.md", "packages/.cache/out.js"],
      "FN-2": [".fusion/tasks/FN-1/PROMPT.md", "packages/.cache/out.js"],
    };

    const event = await detector.detectGridlock();
    expect(event?.blockedTaskIds).toEqual(["FN-1"]);
    expect(event?.reasons).toEqual({ "FN-1": "overlap" });
    expect(event?.blockingTaskIds).toEqual(["FN-2"]);
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
