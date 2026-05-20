import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import {
  DependencyBlockedTodoReporter,
  DEPENDENCY_BLOCKED_TODO_TITLE_PREFIX,
} from "../dependency-blocked-todo-reporter.js";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    description: "test",
    title: "Test task",
    column: "todo",
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
  tasks?: Task[];
  insightStore?: { upsertInsight: ReturnType<typeof vi.fn>; listInsights: ReturnType<typeof vi.fn> };
  throwInsightStore?: boolean;
}): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue(params.settings ?? {}),
    listTasks: vi.fn().mockResolvedValue(params.tasks ?? []),
    getInsightStore: vi.fn().mockImplementation(() => {
      if (params.throwInsightStore) throw new Error("missing insight store");
      return params.insightStore;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

describe("DependencyBlockedTodoReporter", () => {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const now = Date.parse("2026-05-18T12:00:00.000Z");

  beforeEach(() => vi.clearAllMocks());

  it("no-ops when disabled", async () => {
    const store = createStore({ settings: { dependencyBlockedTodoReportEnabled: false } });
    const reporter = new DependencyBlockedTodoReporter({ store, projectId: "/tmp/project", logger, now: () => now });
    await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "disabled" });
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("rejects invalid config", async () => {
    const store = createStore({ settings: { dependencyBlockedTodoFreshAgeMs: -1 } });
    const reporter = new DependencyBlockedTodoReporter({ store, projectId: "/tmp/project", logger, now: () => now });
    await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "invalid-config" });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns no-blocked-groups when no dependency-blocked todos exist", async () => {
    const store = createStore({ tasks: [createTask({ id: "FN-0", column: "in-progress" })] });
    const reporter = new DependencyBlockedTodoReporter({ store, projectId: "/tmp/project", logger, now: () => now });
    await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "no-blocked-groups" });
  });

  it("suppresses single fresh group noise", async () => {
    const tasks = [
      createTask({ id: "FN-B", column: "in-progress", columnMovedAt: "2026-05-18T11:58:00.000Z" }),
      createTask({ id: "FN-T1", dependencies: ["FN-B"] }),
    ];
    const store = createStore({ tasks });
    const reporter = new DependencyBlockedTodoReporter({ store, projectId: "/tmp/project", logger, now: () => now });
    await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "below-significance" });
  });

  it("emits stale grouped insight payload", async () => {
    const tasks = [
      createTask({ id: "FN-5090", column: "in-progress", title: "Blocker", columnMovedAt: "2026-05-18T05:00:00.000Z" }),
      createTask({ id: "FN-5034", dependencies: ["FN-5090"] }),
      createTask({ id: "FN-5085", dependencies: ["FN-5090"] }),
      createTask({ id: "FN-5089", dependencies: ["FN-5090"] }),
    ];
    const insightStore = { upsertInsight: vi.fn(), listInsights: vi.fn().mockReturnValue([]) };
    const store = createStore({ tasks, insightStore });
    const reporter = new DependencyBlockedTodoReporter({ store, projectId: "/tmp/project", logger, now: () => now });

    const result = await reporter.report();
    expect(result).toEqual({ alerted: true, groupCount: 1 });
    expect(insightStore.upsertInsight).toHaveBeenCalledTimes(1);
    const payload = insightStore.upsertInsight.mock.calls[0][1];
    expect(payload.title).toBe(`${DEPENDENCY_BLOCKED_TODO_TITLE_PREFIX} 2026-05-18`);
    expect(payload.category).toBe("workflow");
    expect(payload.provenance.relatedEntityIds).toEqual(["FN-5090"]);
    const content = JSON.parse(payload.content);
    expect(content.groups).toHaveLength(1);
    expect(content.groups[0]).toMatchObject({ blockerId: "FN-5090", blockedTodoCount: 3, blockerTitle: "Blocker" });
  });

  it("suppresses under cooldown", async () => {
    const tasks = [
      createTask({ id: "FN-5090", column: "in-progress", columnMovedAt: "2026-05-18T05:00:00.000Z" }),
      createTask({ id: "FN-5034", dependencies: ["FN-5090"] }),
      createTask({ id: "FN-5085", dependencies: ["FN-5090"] }),
      createTask({ id: "FN-5089", dependencies: ["FN-5090"] }),
    ];
    const insightStore = {
      upsertInsight: vi.fn(),
      listInsights: vi.fn().mockReturnValue([{ title: `${DEPENDENCY_BLOCKED_TODO_TITLE_PREFIX} 2026-05-18`, updatedAt: "2026-05-18T11:59:30.000Z" }]),
    };
    const store = createStore({ tasks, insightStore, settings: { dependencyBlockedTodoReportCooldownMs: 60_000 } });
    const reporter = new DependencyBlockedTodoReporter({ store, projectId: "/tmp/project", logger, now: () => now });
    await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "cooldown" });
  });

  it("re-emits outside cooldown", async () => {
    const tasks = [
      createTask({ id: "FN-5090", column: "in-progress", columnMovedAt: "2026-05-18T05:00:00.000Z" }),
      createTask({ id: "FN-5034", dependencies: ["FN-5090"] }),
      createTask({ id: "FN-5085", dependencies: ["FN-5090"] }),
      createTask({ id: "FN-5089", dependencies: ["FN-5090"] }),
    ];
    const insightStore = {
      upsertInsight: vi.fn(),
      listInsights: vi.fn().mockReturnValue([{ title: `${DEPENDENCY_BLOCKED_TODO_TITLE_PREFIX} 2026-05-17`, updatedAt: "2026-05-18T11:58:00.000Z" }]),
    };
    const store = createStore({ tasks, insightStore, settings: { dependencyBlockedTodoReportCooldownMs: 60_000 } });
    const reporter = new DependencyBlockedTodoReporter({ store, projectId: "/tmp/project", logger, now: () => now });
    await expect(reporter.report()).resolves.toEqual({ alerted: true, groupCount: 1 });
    expect(insightStore.upsertInsight).toHaveBeenCalledTimes(1);
  });

  it("falls back to logEntry when insight store unavailable", async () => {
    const tasks = [
      createTask({ id: "FN-5090", column: "in-progress", columnMovedAt: "2026-05-18T05:00:00.000Z" }),
      createTask({ id: "FN-5034", dependencies: ["FN-5090"] }),
      createTask({ id: "FN-5085", dependencies: ["FN-5090"] }),
      createTask({ id: "FN-5089", dependencies: ["FN-5090"] }),
    ];
    const store = createStore({ tasks, throwInsightStore: true });
    const reporter = new DependencyBlockedTodoReporter({ store, projectId: "/tmp/project", logger, now: () => now });

    await expect(reporter.report()).resolves.toEqual({ alerted: true, groupCount: 1 });
    expect(store.logEntry).toHaveBeenCalledWith("FN-5090", expect.stringContaining("[dependency-blocked-todo]"));
    expect(logger.warn).toHaveBeenCalled();
  });

  it("honors injected now for deterministic age bucket", async () => {
    const tasks = [
      createTask({ id: "FN-5090", column: "in-progress", columnMovedAt: "2026-05-18T11:20:00.000Z" }),
      createTask({ id: "FN-5034", dependencies: ["FN-5090"] }),
      createTask({ id: "FN-5085", dependencies: ["FN-5090"] }),
      createTask({ id: "FN-5089", dependencies: ["FN-5090"] }),
    ];
    const insightStore = { upsertInsight: vi.fn(), listInsights: vi.fn().mockReturnValue([]) };
    const store = createStore({ tasks, insightStore });
    const reporter = new DependencyBlockedTodoReporter({ store, projectId: "/tmp/project", logger, now: () => Date.parse("2026-05-18T12:00:00.000Z") });
    await reporter.report();
    const content = JSON.parse(insightStore.upsertInsight.mock.calls[0][1].content);
    expect(content.groups[0].ageBucket).toBe("aging");
  });
});
