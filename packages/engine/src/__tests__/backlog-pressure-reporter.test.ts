import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { BacklogPressureReporter } from "../backlog-pressure-reporter.js";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    description: "test",
    title: "Test task",
    column: "todo",
    priority: "normal",
    dependencies: [],
    steps: [],
    currentStep: 0,
    paused: false,
    status: undefined,
    blockedBy: "",
    overlapBlockedBy: "",
    log: [],
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(params: {
  settings?: Record<string, unknown>;
  todoSlim?: Task[];
  inProgressSlim?: Task[];
  todoFull?: Task[];
  allTasks?: Task[];
  insightStore?: { upsertInsight: ReturnType<typeof vi.fn>; listInsights: ReturnType<typeof vi.fn> };
  throwInsightStore?: boolean;
}): TaskStore {
  const listTasks = vi.fn().mockImplementation(async (options?: { column?: string; slim?: boolean }) => {
    if (options?.column === "todo" && options?.slim) return params.todoSlim ?? [];
    if (options?.column === "in-progress" && options?.slim) return params.inProgressSlim ?? [];
    if (options?.column === "todo" && !options?.slim) return params.todoFull ?? [];
    if (!options?.column && options?.slim) return params.allTasks ?? [];
    return [];
  });

  return {
    getSettings: vi.fn().mockResolvedValue(params.settings ?? {}),
    listTasks,
    getInsightStore: vi.fn().mockImplementation(() => {
      if (params.throwInsightStore) throw new Error("missing insight store");
      return params.insightStore;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

describe("BacklogPressureReporter", () => {
  const logger = { warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no-ops when disabled", async () => {
    const store = createStore({ settings: { backlogPressureAlertEnabled: false } });
    const reporter = new BacklogPressureReporter({ store, projectId: "/tmp/project", logger });
    await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "disabled" });
  });

  it.each([
    { todo: 25, inProgress: 5, expected: "under-threshold" },
    { todo: 4, inProgress: 0, expected: "under-threshold", settings: { backlogPressureMinTodoCount: 5 } },
  ])("no-ops for threshold matrix %#", async ({ todo, inProgress, expected, settings }) => {
    const todoSlim = Array.from({ length: todo }, (_, i) => createTask({ id: `FN-T${i}`, title: `Todo ${i}` }));
    const inProgressSlim = Array.from({ length: inProgress }, (_, i) => createTask({ id: `FN-P${i}`, column: "in-progress" }));
    const store = createStore({ settings, todoSlim, inProgressSlim });
    const reporter = new BacklogPressureReporter({ store, projectId: "/tmp/project", logger });
    await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: expected });
  });

  it("no-ops when fewer than 3 runnable candidates exist", async () => {
    const todoSlim = Array.from({ length: 20 }, (_, i) => createTask({ id: `FN-T${i}` }));
    const inProgressSlim = [createTask({ id: "FN-P1", column: "in-progress" })];
    const todoFull = [
      createTask({ id: "FN-1", blockedBy: "FN-0" }),
      createTask({ id: "FN-2", paused: true }),
      createTask({ id: "FN-3", status: "queued" as Task["status"] }),
      createTask({ id: "FN-4" }),
      createTask({ id: "FN-5" }),
    ];
    const allTasks = [...todoFull, createTask({ id: "FN-0", column: "todo" })];
    const store = createStore({ todoSlim, inProgressSlim, todoFull, allTasks, insightStore: { upsertInsight: vi.fn(), listInsights: vi.fn().mockReturnValue([]) } });
    const reporter = new BacklogPressureReporter({ store, projectId: "/tmp/project", logger });
    await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "insufficient-candidates" });
  });

  it("excludes dependency-blocked candidates but keeps missing-dependency refs", async () => {
    const todoSlim = Array.from({ length: 44 }, (_, i) => createTask({ id: `FN-T${i}` }));
    const inProgressSlim = [createTask({ id: "FN-P1", column: "in-progress" }), createTask({ id: "FN-P2", column: "in-progress" }), createTask({ id: "FN-P3", column: "in-progress" })];
    const todoFull = [
      createTask({ id: "FN-A", priority: "urgent", blockedBy: "FN-X" }),
      createTask({ id: "FN-B", priority: "high", overlapBlockedBy: "FN-Y" }),
      createTask({ id: "FN-C", priority: "high", status: "queued" as Task["status"] }),
      createTask({ id: "FN-D", priority: "high", paused: true }),
      createTask({ id: "FN-E", priority: "urgent", dependencies: ["FN-DEP-TODO"] }),
      createTask({ id: "FN-F", priority: "urgent", dependencies: ["FN-DEP-MISSING"] }),
      createTask({ id: "FN-G", priority: "high" }),
      createTask({ id: "FN-H", priority: "normal" }),
    ];
    const allTasks = [
      ...todoFull,
      createTask({ id: "FN-DEP-TODO", column: "todo" }),
      createTask({ id: "FN-DEP-DONE", column: "done" }),
    ];
    const insightStore = { upsertInsight: vi.fn(), listInsights: vi.fn().mockReturnValue([]) };
    const reporter = new BacklogPressureReporter({
      store: createStore({ todoSlim, inProgressSlim, todoFull, allTasks, insightStore }),
      projectId: "/tmp/project",
      logger,
      now: () => Date.parse("2026-05-18T12:00:00.000Z"),
    });

    const result = await reporter.report();
    expect(result.alerted).toBe(true);
    const content = JSON.parse(insightStore.upsertInsight.mock.calls[0][1].content);
    const ids = content.candidates.map((candidate: { id: string }) => candidate.id);
    expect(ids).toContain("FN-F");
    expect(ids).toContain("FN-G");
    expect(ids).toContain("FN-H");
    expect(ids).not.toContain("FN-A");
    expect(ids).not.toContain("FN-B");
    expect(ids).not.toContain("FN-C");
    expect(ids).not.toContain("FN-D");
    expect(ids).not.toContain("FN-E");
  });

  it("emits payload with counts, ratio, detectedAt, and candidates", async () => {
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    const todoSlim = Array.from({ length: 44 }, (_, i) => createTask({ id: `FN-T${i}` }));
    const inProgressSlim = [createTask({ id: "FN-P1", column: "in-progress" }), createTask({ id: "FN-P2", column: "in-progress" }), createTask({ id: "FN-P3", column: "in-progress" })];
    const todoFull = Array.from({ length: 8 }, (_, i) => createTask({ id: `FN-C${i}`, title: `Candidate ${i}`, priority: i === 0 ? "urgent" : "normal" }));
    const insightStore = { upsertInsight: vi.fn(), listInsights: vi.fn().mockReturnValue([]) };
    const store = createStore({ todoSlim, inProgressSlim, todoFull, allTasks: todoFull, insightStore });
    const reporter = new BacklogPressureReporter({ store, projectId: "/tmp/project", logger, now: () => now });

    const result = await reporter.report();
    expect(result).toEqual({ alerted: true });
    expect(insightStore.upsertInsight).toHaveBeenCalledTimes(1);
    const input = insightStore.upsertInsight.mock.calls[0][1];
    const content = JSON.parse(input.content);
    expect(content.todoCount).toBe(44);
    expect(content.inProgressCount).toBe(3);
    expect(content.ratio).toBe(14.67);
    expect(content.detectedAt).toBe("2026-05-18T12:00:00.000Z");
    expect(content.candidates.length).toBeGreaterThanOrEqual(3);
  });

  it("respects cooldown window", async () => {
    vi.useFakeTimers();
    try {
      const baseNow = Date.parse("2026-05-18T12:00:00.000Z");
      vi.setSystemTime(baseNow);
      const todoSlim = Array.from({ length: 44 }, (_, i) => createTask({ id: `FN-T${i}` }));
      const inProgressSlim = Array.from({ length: 3 }, (_, i) => createTask({ id: `FN-P${i}`, column: "in-progress" }));
      const todoFull = Array.from({ length: 5 }, (_, i) => createTask({ id: `FN-C${i}` }));
      const insightStore = {
        upsertInsight: vi.fn(),
        listInsights: vi.fn().mockReturnValue([]),
      };
      const store = createStore({ todoSlim, inProgressSlim, todoFull, allTasks: todoFull, insightStore, settings: { backlogPressureAlertCooldownMs: 60_000 } });
      const reporter = new BacklogPressureReporter({ store, projectId: "/tmp/project", logger, now: () => Date.now() });

      await reporter.report();
      expect(insightStore.upsertInsight).toHaveBeenCalledTimes(1);

      insightStore.listInsights.mockReturnValue([
        { title: "Backlog pressure detected 2026-05-18", updatedAt: new Date(Date.now()).toISOString() },
      ]);
      await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "under-threshold" });
      expect(insightStore.upsertInsight).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(61_000);
      insightStore.listInsights.mockReturnValue([
        { title: "Backlog pressure detected 2026-05-18", updatedAt: new Date(baseNow).toISOString() },
      ]);
      await reporter.report();
      expect(insightStore.upsertInsight).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to task log entry when insight store is unavailable", async () => {
    const todoSlim = Array.from({ length: 44 }, (_, i) => createTask({ id: `FN-T${i}` }));
    const inProgressSlim = Array.from({ length: 3 }, (_, i) => createTask({ id: `FN-P${i}`, column: "in-progress" }));
    const todoFull = [
      createTask({ id: "FN-1", priority: "urgent" }),
      createTask({ id: "FN-2", priority: "high" }),
      createTask({ id: "FN-3", priority: "normal" }),
    ];
    const store = createStore({ todoSlim, inProgressSlim, todoFull, allTasks: todoFull, throwInsightStore: true });
    const reporter = new BacklogPressureReporter({ store, projectId: "/tmp/project", logger });

    const result = await reporter.report();
    expect(result).toEqual({ alerted: true });
    expect(store.logEntry).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", expect.stringContaining("[backlog-pressure]"));
  });
});
