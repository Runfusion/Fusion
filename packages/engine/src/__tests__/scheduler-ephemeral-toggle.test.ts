import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Scheduler } from "../scheduler.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn() };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn() };
});

const PASSED_PLAN_REVIEW = {
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  status: "passed" as const,
  source: "node" as const,
  phase: "pre-merge" as const,
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-8821-SCHEDULER",
    title: "Scheduler compatibility regression",
    description: "A dispatchable workflow task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workflowStepResults: [PASSED_PLAN_REVIEW],
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function storeWith(ready: Task): TaskStore {
  const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(ready, patch));
  return {
    listTasks: vi.fn(async () => [ready]),
    getTask: vi.fn(async () => ready),
    getSettings: vi.fn(async () => ({
      maxConcurrent: 2,
      maxWorktrees: 4,
    })),
    updateSettings: vi.fn(async () => undefined),
    updateTask,
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      ready.column = column;
      return ready;
    }),
    moveTaskIf: vi.fn(async (_id: string, column: Task["column"], predicate: (live: Task) => boolean | Promise<boolean>) => {
      if (!await predicate(ready) || ready.column === column) return { task: ready, moved: false };
      ready.column = column;
      return { task: ready, moved: true };
    }),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    logEntry: vi.fn(async () => undefined),
    transitionQueuedEpisode: vi.fn(async () => ({ appended: true, task: ready })),
    getRootDir: vi.fn(() => "/tmp/fn-8821-scheduler"),
    getTasksDir: vi.fn(() => "/tmp/fn-8821-scheduler/.fusion/tasks"),
    on: vi.fn(),
    off: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
    renewSymbolLocks: vi.fn(async () => ({ renewed: [], lost: [] })),
    getMissionStore: vi.fn(() => ({ listMissions: () => [], listGoalIdsForMission: () => [] })),
  } as unknown as TaskStore;
}

/*
FNXC:WorkflowScheduling 2026-08-09-01:04:
FN-8847 removes the retired compatibility toggle. Scheduler release must hand workflow tasks to
graph admission without legacy assignment or queueing; durable principals resolve that authority later.
*/
describe("scheduler releases workflow tasks for durable principal routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue("# Task\nBody");
  });

  it("releases an unassigned workflow task without legacy assignment or queueing", async () => {
      const ready = task();
      const store = storeWith(ready);
      const onSchedule = vi.fn();
      const scheduler = new Scheduler(store, { onSchedule });
      (scheduler as unknown as { running: boolean }).running = true;

      await scheduler.schedule();

      expect(ready.column).toBe("in-progress");
      expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: ready.id, column: "in-progress" }));
      expect(store.updateTask).not.toHaveBeenCalledWith(ready.id, expect.objectContaining({ assignedAgentId: expect.any(String) }));
      expect(store.updateTask).not.toHaveBeenCalledWith(ready.id, expect.objectContaining({ status: "queued" }));
      expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });

  it("preserves an assigned task's normal release", async () => {
      const ready = task({ id: "FN-8821-SCHEDULER-ASSIGNED", assignedAgentId: "durable-owner" });
      const store = storeWith(ready);
      const onSchedule = vi.fn();
      const scheduler = new Scheduler(store, { onSchedule });
      (scheduler as unknown as { running: boolean }).running = true;

      await scheduler.schedule();

      expect(ready.column).toBe("in-progress");
      expect(ready.assignedAgentId).toBe("durable-owner");
      expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: ready.id, column: "in-progress" }));
      expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });
});
