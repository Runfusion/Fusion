// @vitest-environment node

import { describe, it, expect, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { get as performGet, request as performRequest } from "../test-request.js";

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
    },
    comments: [],
    ...overrides,
  } as Task;
}

function createStore(task: Task): TaskStore {
  return {
    getTask: vi.fn().mockResolvedValue(task),
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
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    updatePrInfoByNumber: vi.fn().mockResolvedValue(undefined),
    addPrInfo: vi.fn().mockResolvedValue(undefined),
    removePrInfoByNumber: vi.fn().mockResolvedValue(undefined),
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

describe("PR routes contract", () => {
  it("returns structured 404 when task has no PR for status/refresh/reviews", async () => {
    const app = createServer(createStore(createTask({ prInfo: undefined })));

    const statusRes = await performGet(app, "/api/tasks/FN-001/pr/status");
    const refreshRes = await performRequest(app, "POST", "/api/tasks/FN-001/pr/refresh", "{}", { "content-type": "application/json" });
    const reviewsRes = await performGet(app, "/api/tasks/FN-001/pr/reviews");

    for (const res of [statusRes, refreshRes, reviewsRes]) {
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: expect.stringContaining("no associated PR") });
    }
  });

  it("rejects invalid PR create request body with structured error", async () => {
    const app = createServer(createStore(createTask({ prInfo: undefined })));
    const response = await performRequest(app, "POST", "/api/tasks/FN-001/pr/create", JSON.stringify({}), {
      "content-type": "application/json",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("title is required");
  });

  it("does not return conflict when task already has PR", async () => {
    const app = createServer(createStore(createTask()));
    const response = await performRequest(app, "POST", "/api/tasks/FN-001/pr/create", JSON.stringify({ title: "x" }), {
      "content-type": "application/json",
    });

    expect(response.status).not.toBe(409);
  });

  it("returns structured 404 for PR options when task is missing", async () => {
    const missingStore = createStore(createTask());
    missingStore.getTask = vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const app = createServer(missingStore);

    const response = await performGet(app, "/api/tasks/FN-404/pr/options");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: expect.stringContaining("Task FN-404 not found") });
  });

  it("returns structured 404 for PR preflight when task is missing", async () => {
    const missingStore = createStore(createTask());
    missingStore.getTask = vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const app = createServer(missingStore);

    const response = await performGet(app, "/api/tasks/FN-404/pr/preflight");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: expect.stringContaining("Task FN-404 not found") });
  });

  it("returns structured 404 for PR metadata generation when task is missing", async () => {
    const missingStore = createStore(createTask());
    missingStore.getTask = vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const app = createServer(missingStore);

    const response = await performRequest(app, "POST", "/api/tasks/FN-404/pr/generate-metadata", "{}", {
      "content-type": "application/json",
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: expect.stringContaining("Task FN-404 not found") });
  });
});
