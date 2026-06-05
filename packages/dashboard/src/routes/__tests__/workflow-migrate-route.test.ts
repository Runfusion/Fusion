// @vitest-environment node
//
// U2/R5 — HTTP integration coverage for POST /api/workflows/migrate-legacy-steps.
// Exercises the route end-to-end against a REAL TaskStore (no store-method
// mocking — mock-masked dead-wiring learning): the route must invoke the real
// migration seam, persist fragments + a combined workflow, and be idempotent.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, isBuiltinWorkflowId } from "@fusion/core";
import { registerWorkflowRoutes } from "../register-workflow-routes.js";
import { ApiError, sendErrorResponse } from "../../api-error.js";
import { request } from "../../test-request.js";

describe("POST /api/workflows/migrate-legacy-steps (U2/R5)", () => {
  let store: TaskStore;
  let rootDir: string;
  let globalDir: string;
  let app: express.Express;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "wf-migrate-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "wf-migrate-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();

    app = express();
    app.use(express.json());
    const router = express.Router();
    registerWorkflowRoutes({
      router,
      getProjectContext: async () => ({ store, engine: undefined, projectId: undefined }),
      rethrowAsApiError: (err: unknown) => {
        throw err instanceof ApiError ? err : new ApiError(500, err instanceof Error ? err.message : String(err));
      },
    } as unknown as Parameters<typeof registerWorkflowRoutes>[0]);
    app.use("/api", router);
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof ApiError) sendErrorResponse(res, err.statusCode, err.message, { details: err.details });
      else sendErrorResponse(res, 500, err instanceof Error ? err.message : String(err));
    });
  });

  afterEach(() => {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  const post = (path: string) => request(app, "POST", path);

  async function userDefCount() {
    return (await store.listWorkflowDefinitions()).filter((w) => !isBuiltinWorkflowId(w.id)).length;
  }

  it("migrates legacy steps and returns counts matching the created definitions", async () => {
    await store.createWorkflowStep({ name: "On", description: "x", prompt: "p", defaultOn: true });
    await store.createWorkflowStep({ name: "Off", description: "y", prompt: "q", defaultOn: false });

    const res = await post("/api/workflows/migrate-legacy-steps");
    expect(res.status).toBe(200);
    const body = res.body as { migrated: number; skipped: number; combinedWorkflowId?: string };
    expect(body.migrated).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.combinedWorkflowId).toBeTruthy();

    // 2 fragments + 1 combined workflow were actually persisted via the real store.
    expect(await userDefCount()).toBe(3);
    expect(await store.getDefaultWorkflowId()).toBe(body.combinedWorkflowId);
  });

  it("is idempotent: a second POST converts nothing and creates no new definitions", async () => {
    await store.createWorkflowStep({ name: "On", description: "x", prompt: "p", defaultOn: true });

    const first = (await post("/api/workflows/migrate-legacy-steps")).body as { migrated: number };
    expect(first.migrated).toBe(1);
    const afterFirst = await userDefCount();

    const res = await post("/api/workflows/migrate-legacy-steps");
    expect(res.status).toBe(200);
    const body = res.body as { migrated: number; skipped: number; combinedWorkflowId?: string };
    expect(body.migrated).toBe(0);
    expect(body.skipped).toBe(1);
    expect(body.combinedWorkflowId).toBeUndefined();
    expect(await userDefCount()).toBe(afterFirst);
  });
});
