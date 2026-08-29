// @vitest-environment node

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { registerGitLabRoutes } from "../routes/register-gitlab.js";
import { request as performRequest } from "../test-request.js";
import { GitLabSourceIssueReconciler, GITLAB_RECONCILE_SCAN_LIMIT } from "../gitlab-source-issue-reconciler.js";
import type { ApiRoutesContext } from "../routes/types.js";

function createStore(name: string): TaskStore {
  return {
    getRootDir: vi.fn().mockReturnValue(`/tmp/${name}`),
    getFusionDir: vi.fn().mockReturnValue(`/tmp/${name}/.fusion`),
    listTasks: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({}),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn().mockResolvedValue({}) })),
    logEntry: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

function createApp(storeForProject: (projectId?: string) => TaskStore = () => createStore("default")) {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const ctx = {
    router,
    getProjectContext: vi.fn(async (req: any) => ({ store: storeForProject(req.body?.projectId), projectId: req.body?.projectId ?? "default" })),
    rethrowAsApiError(error: unknown): never {
      throw error;
    },
  } as unknown as ApiRoutesContext;
  registerGitLabRoutes(ctx);
  app.use("/api", router);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? err.status ?? 500).json({ error: err.message }));
  return { app, ctx };
}

describe("POST /api/git/gitlab/backfill-source-issue-closed-at", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the GitLab reconciler backfill result", async () => {
    const store = createStore("default");
    const result = { scanned: 2, filled: 1, skipped: 1, errors: 0, hasMore: false };
    const backfill = vi.spyOn(GitLabSourceIssueReconciler.prototype, "backfillSourceIssueClosedAt").mockResolvedValue(result);
    const { app } = createApp(() => store);

    const response = await performRequest(app, "POST", "/api/git/gitlab/backfill-source-issue-closed-at", "{}", { "content-type": "application/json" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(backfill).toHaveBeenCalledWith(store, { offset: 0, limit: GITLAB_RECONCILE_SCAN_LIMIT });
  });

  it("uses the scoped project store from projectId", async () => {
    const storeA = createStore("proj-a");
    const storeB = createStore("proj-b");
    const backfill = vi.spyOn(GitLabSourceIssueReconciler.prototype, "backfillSourceIssueClosedAt")
      .mockResolvedValue({ scanned: 0, filled: 0, skipped: 0, errors: 0, hasMore: false });
    const { app, ctx } = createApp((projectId) => projectId === "proj-a" ? storeA : storeB);

    const response = await performRequest(
      app,
      "POST",
      "/api/git/gitlab/backfill-source-issue-closed-at",
      JSON.stringify({ projectId: "proj-a" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(ctx.getProjectContext).toHaveBeenCalled();
    expect(backfill).toHaveBeenCalledWith(storeA, { offset: 0, limit: GITLAB_RECONCILE_SCAN_LIMIT });
    expect(backfill).not.toHaveBeenCalledWith(storeB, expect.anything());
  });

  it("validates offset and clamps limit to the reconcile scan limit", async () => {
    const store = createStore("default");
    const backfill = vi.spyOn(GitLabSourceIssueReconciler.prototype, "backfillSourceIssueClosedAt")
      .mockResolvedValue({ scanned: 0, filled: 0, skipped: 0, errors: 0, hasMore: false });
    const { app } = createApp(() => store);

    const clamped = await performRequest(
      app,
      "POST",
      "/api/git/gitlab/backfill-source-issue-closed-at",
      JSON.stringify({ offset: 5, limit: GITLAB_RECONCILE_SCAN_LIMIT + 99 }),
      { "content-type": "application/json" },
    );
    const invalid = await performRequest(
      app,
      "POST",
      "/api/git/gitlab/backfill-source-issue-closed-at",
      JSON.stringify({ offset: -1 }),
      { "content-type": "application/json" },
    );

    expect(clamped.status).toBe(200);
    expect(backfill).toHaveBeenCalledWith(store, { offset: 5, limit: GITLAB_RECONCILE_SCAN_LIMIT });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("offset must be a non-negative integer");
  });

  it("surfaces reconciler failures without routing to GitHub-only code", async () => {
    const store = createStore("default");
    vi.spyOn(GitLabSourceIssueReconciler.prototype, "backfillSourceIssueClosedAt").mockRejectedValue(new Error("gitlab boom"));
    const { app } = createApp(() => store);

    const response = await performRequest(app, "POST", "/api/git/gitlab/backfill-source-issue-closed-at", "{}", { "content-type": "application/json" });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("gitlab boom");
  });
});
