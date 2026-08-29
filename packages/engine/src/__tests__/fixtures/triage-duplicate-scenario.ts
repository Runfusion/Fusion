import { vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";

/**
 * FN-4726 / FN-4734 / FN-4741 documented a triple-duplicate triage incident where
 * semantically identical work was repeatedly filed after the original fix was already
 * completed. FN-4774 fixed that failure mode by adding fn_task_search to triage tools
 * and explicit prompt guidance to search done/archived tasks before creating new work.
 * FN-4815 adds a regression backstop so this scenario remains reusable across future
 * triage reliability tests.
 */
export function createTriageDuplicateScenario() {
  const doneTask: Task = {
    id: "FN-DUP-DONE",
    title: "Fix mobile nav overlap on iOS Safari",
    description:
      "Resolve iOS Safari viewport overlap where the mobile nav obscures the bottom row.",
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const incomingRequest = {
    title: "Mobile nav still overlapping on iOS Safari",
    description:
      "Users report the bottom action row is covered by mobile nav on iPhone Safari. Check prior fixes before creating a new task.",
  };

  const searchQuery = "mobile nav overlap iOS Safari bottom action row";
  const expectedMatchIds = [doneTask.id];

  function buildMockStore(): TaskStore {
    return {
      searchTasks: vi.fn().mockResolvedValue([doneTask]),
      listTasks: vi.fn().mockResolvedValue([]),
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        autoMerge: true,
      } as Settings),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      updateTask: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      emit: vi.fn(),
    } as unknown as TaskStore;
  }

  return {
    doneTask,
    incomingRequest,
    searchQuery,
    expectedMatchIds,
    buildMockStore,
  };
}
