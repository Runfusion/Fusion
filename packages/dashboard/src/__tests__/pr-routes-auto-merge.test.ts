// @vitest-environment node

import { describe, it, expect, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { request as performRequest } from "../test-request.js";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Task",
    description: "desc",
    column: "in-review",
    status: "in-review",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prInfo: {
      url: "https://github.com/owner/repo/pull/1",
      number: 1,
      status: "open",
      title: "PR",
      headBranch: "fusion/fn-001",
      baseBranch: "main",
      commentCount: 0,
      autoMergeOnGreen: false,
      autoMergeStrategy: "squash",
      lastMergeError: "old",
      lastMergeErrorAt: new Date().toISOString(),
    },
    ...overrides,
  } as Task;
}

function createStore(task: Task): TaskStore {
  return {
    getTask: vi.fn().mockResolvedValue(task),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    updatePrInfoByNumber: vi.fn().mockResolvedValue(undefined),
    addPrInfo: vi.fn().mockResolvedValue(undefined),
    removePrInfoByNumber: vi.fn().mockResolvedValue(undefined),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    updateIssueInfo: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/tmp/project"),
    getFusionDir: vi.fn().mockReturnValue("/tmp/project/.fusion"),
    getDatabase: vi.fn().mockReturnValue({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    }),
    getMissionStore: vi.fn().mockReturnValue({ listMissions: vi.fn().mockReturnValue([]) }),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

describe("PR auto-merge routes", () => {
  it("updates auto-merge settings and clears stale merge error fields", async () => {
    const task = createTask();
    const store = createStore(task);
    const app = createServer(store);

    const response = await performRequest(
      app,
      "POST",
      "/api/tasks/FN-001/pr/auto-merge",
      JSON.stringify({ enabled: true, strategy: "rebase" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(store.updatePrInfoByNumber).toHaveBeenCalledWith(
      "FN-001",
      1,
      expect.objectContaining({
        autoMergeOnGreen: true,
        autoMergeStrategy: "rebase",
        lastMergeError: undefined,
        lastMergeErrorAt: undefined,
      }),
    );
  });

  it("rejects invalid auto-merge strategy", async () => {
    const app = createServer(createStore(createTask()));
    const response = await performRequest(
      app,
      "POST",
      "/api/tasks/FN-001/pr/auto-merge",
      JSON.stringify({ enabled: true, strategy: "invalid" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid auto-merge strategy");
  });

  it("rejects invalid merge method on merge endpoint", async () => {
    const app = createServer(createStore(createTask()));
    const response = await performRequest(
      app,
      "POST",
      "/api/tasks/FN-001/pr/merge",
      JSON.stringify({ method: "invalid" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid merge method");
  });
});
