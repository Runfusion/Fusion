// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { request as performRequest } from "../test-request.js";

function createStore(results: Array<{ taskId: string; column: string; cleared: boolean }> = []): TaskStore {
  return {
    reconcileLegacyAutoMergeStamps: vi.fn().mockResolvedValue(results),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getRootDir: vi.fn().mockReturnValue("/tmp/project"),
    getFusionDir: vi.fn().mockReturnValue("/tmp/project/.fusion"),
    listTasks: vi.fn().mockResolvedValue([]),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    getActivityLog: vi.fn().mockResolvedValue([]),
    getDatabase: vi.fn().mockReturnValue({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    }),
    getMissionStore: vi.fn().mockReturnValue({ listMissions: vi.fn().mockReturnValue([]) }),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

describe("legacy auto-merge stamp maintenance routes", () => {
  it("GET returns dry-run candidates without apply", async () => {
    const candidates = [{ taskId: "FN-101", column: "in-review", cleared: false }];
    const store = createStore(candidates);
    const app = createServer(store);

    const response = await performRequest(app, "GET", "/api/maintenance/legacy-automerge-stamps");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ candidates, count: 1 });
    expect(store.reconcileLegacyAutoMergeStamps).toHaveBeenCalledWith();
  });

  it("POST delegates apply to the store API and returns cleared count", async () => {
    const cleared = [{ taskId: "FN-101", column: "in-review", cleared: true }];
    const store = createStore(cleared);
    const app = createServer(store);

    const response = await performRequest(app, "POST", "/api/maintenance/legacy-automerge-stamps/apply");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ cleared, count: 1 });
    expect(store.reconcileLegacyAutoMergeStamps).toHaveBeenCalledWith({ apply: true });
  });

  it("handles zero-candidate dry-run and apply as clean no-ops", async () => {
    const store = createStore([]);
    const app = createServer(store);

    const dryRun = await performRequest(app, "GET", "/api/maintenance/legacy-automerge-stamps");
    const applied = await performRequest(app, "POST", "/api/maintenance/legacy-automerge-stamps/apply");

    expect(dryRun.status).toBe(200);
    expect(dryRun.body).toEqual({ candidates: [], count: 0 });
    expect(applied.status).toBe(200);
    expect(applied.body).toEqual({ cleared: [], count: 0 });
  });

  it("maps store errors through the API error handler", async () => {
    const store = createStore();
    vi.mocked(store.reconcileLegacyAutoMergeStamps).mockRejectedValue(new Error("store unavailable"));
    const app = createServer(store);

    const response = await performRequest(app, "GET", "/api/maintenance/legacy-automerge-stamps");

    expect(response.status).toBe(500);
    expect(response.body.error).toContain("store unavailable");
  });
});
