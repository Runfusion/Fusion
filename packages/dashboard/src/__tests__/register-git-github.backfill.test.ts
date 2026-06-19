// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { request as performRequest } from "../test-request.js";
import { GitHubTrackingReconciler, RECONCILE_SCAN_LIMIT } from "../github-tracking-reconciler.js";
import * as projectStoreResolver from "../project-store-resolver.js";

function createStore(name: string): TaskStore {
  return {
    getRootDir: vi.fn().mockReturnValue(`/tmp/${name}`),
    getFusionDir: vi.fn().mockReturnValue(`/tmp/${name}/.fusion`),
    listTasks: vi.fn().mockResolvedValue([]),
    listTasksForGithubTrackingReconcile: vi.fn().mockResolvedValue({ tasks: [], hasMore: false }),
    getSettings: vi.fn().mockResolvedValue({}),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn().mockResolvedValue({}) })),
    logEntry: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    getDatabase: vi.fn().mockReturnValue({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    }),
    getMissionStore: vi.fn().mockReturnValue({ listMissions: vi.fn().mockReturnValue([]) }),
  } as unknown as TaskStore;
}

describe("POST /api/git/github/backfill-source-issue-closed-at", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the reconciler backfill result", async () => {
    const store = createStore("default");
    const result = { scanned: 2, filled: 1, skipped: 1, errors: 0, hasMore: false };
    const backfill = vi.spyOn(GitHubTrackingReconciler.prototype, "backfillSourceIssueClosedAt").mockResolvedValue(result);
    const app = createServer(store);

    const response = await performRequest(app, "POST", "/api/git/github/backfill-source-issue-closed-at", "{}", { "content-type": "application/json" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(backfill).toHaveBeenCalledWith(store, { offset: 0, limit: RECONCILE_SCAN_LIMIT });
  });

  it("uses the scoped project store from projectId", async () => {
    const defaultStore = createStore("default");
    const storeA = createStore("proj-a");
    const storeB = createStore("proj-b");
    vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockImplementation(async (projectId: string) => {
      if (projectId === "proj-a") return storeA;
      if (projectId === "proj-b") return storeB;
      return defaultStore;
    });
    const backfill = vi.spyOn(GitHubTrackingReconciler.prototype, "backfillSourceIssueClosedAt")
      .mockResolvedValue({ scanned: 0, filled: 0, skipped: 0, errors: 0, hasMore: false });
    const app = createServer(defaultStore);

    const response = await performRequest(
      app,
      "POST",
      "/api/git/github/backfill-source-issue-closed-at",
      JSON.stringify({ projectId: "proj-a" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith("proj-a");
    expect(backfill).toHaveBeenCalledWith(storeA, { offset: 0, limit: RECONCILE_SCAN_LIMIT });
    expect(backfill).not.toHaveBeenCalledWith(storeB, expect.anything());
  });

  it("validates offset and clamps limit to the reconcile scan limit", async () => {
    const store = createStore("default");
    const backfill = vi.spyOn(GitHubTrackingReconciler.prototype, "backfillSourceIssueClosedAt")
      .mockResolvedValue({ scanned: 0, filled: 0, skipped: 0, errors: 0, hasMore: false });
    const app = createServer(store);

    const clamped = await performRequest(
      app,
      "POST",
      "/api/git/github/backfill-source-issue-closed-at",
      JSON.stringify({ offset: 5, limit: RECONCILE_SCAN_LIMIT + 99 }),
      { "content-type": "application/json" },
    );
    const invalid = await performRequest(
      app,
      "POST",
      "/api/git/github/backfill-source-issue-closed-at",
      JSON.stringify({ offset: -1 }),
      { "content-type": "application/json" },
    );

    expect(clamped.status).toBe(200);
    expect(backfill).toHaveBeenCalledWith(store, { offset: 5, limit: RECONCILE_SCAN_LIMIT });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("offset must be a non-negative integer");
  });

  it("surfaces reconciler failures as the standard API error shape", async () => {
    const store = createStore("default");
    vi.spyOn(GitHubTrackingReconciler.prototype, "backfillSourceIssueClosedAt").mockRejectedValue(new Error("boom"));
    const app = createServer(store);

    const response = await performRequest(app, "POST", "/api/git/github/backfill-source-issue-closed-at", "{}", { "content-type": "application/json" });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("boom");
  });
});
