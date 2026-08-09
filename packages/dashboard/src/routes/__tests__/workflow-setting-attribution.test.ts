// @vitest-environment node

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthMiddleware } from "../../auth-middleware.js";
import { ApiError, sendErrorResponse } from "../../api-error.js";
import { request } from "../../test-request.js";
import { registerWorkflowRoutes } from "../register-workflow-routes.js";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { SCHEMA_VERSION, type TaskStore } from "@fusion/core";

const pgTest = pgDescribe;

pgTest("workflow setting revision attribution", () => {
  let harness: PgTestHarness;
  let store: TaskStore;

  beforeEach(async () => {
    harness = await createTaskStoreForTest();
    store = harness.store;
  });
  afterEach(async () => { await harness.teardown(); });

  function appFor(token?: string) {
    const app = express();
    app.use(express.json());
    if (token) app.use(createAuthMiddleware(token));
    const router = express.Router();
    registerWorkflowRoutes({
      router,
      getProjectContext: async () => ({ store, engine: undefined, projectId: undefined }),
      rethrowAsApiError: (error: unknown) => { throw error instanceof ApiError ? error : new ApiError(500, String(error)); },
      options: {},
    } as unknown as Parameters<typeof registerWorkflowRoutes>[0]);
    app.use("/api", router);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ApiError) sendErrorResponse(res, error.statusCode, error.message, { details: error.details });
      else sendErrorResponse(res, 500, String(error));
    });
    return app;
  }

  it("forwards only daemon-verified or unverified API actors for workflow setting patches", async () => {
    const spy = vi.spyOn(store, "updateWorkflowSettingValues");
    const app = appFor("shared-token");
    const verified = await request(app, "PATCH", "/api/workflows/builtin:coding/setting-values", JSON.stringify({ values: { workflowStepTimeoutMs: 1000 } }), { authorization: "Bearer shared-token", "content-type": "application/json" });
    const unverifiedApp = appFor();
    const unverified = await request(unverifiedApp, "PATCH", "/api/workflows/builtin:coding/setting-values", JSON.stringify({ values: { workflowStepTimeoutMs: null } }), { authorization: "Bearer forged", "content-type": "application/json" });

    expect(verified.status).toBe(200);
    expect(unverified.status).toBe(200);
    expect(spy).toHaveBeenNthCalledWith(1, "builtin:coding", expect.any(String), { workflowStepTimeoutMs: 1000 }, { kind: "api", id: "http:verified-token" });
    expect(spy).toHaveBeenNthCalledWith(2, "builtin:coding", expect.any(String), expect.objectContaining({ workflowStepTimeoutMs: null }), { kind: "api", id: "http:unverified" });
  });

  it("forwards API provenance while restoring imported workflow settings", async () => {
    const spy = vi.spyOn(store, "updateWorkflowSettingValues");
    const source = await store.getWorkflowDefinition("builtin:coding");
    expect(source).toBeDefined();
    const response = await request(appFor("shared-token"), "POST", "/api/workflows/import", JSON.stringify({
      fusionWorkflowExport: 1,
      schemaVersion: SCHEMA_VERSION,
      name: "Imported attribution workflow",
      kind: "workflow",
      ir: source!.ir,
      layout: source!.layout,
      settingValues: { workflowStepTimeoutMs: 1000 },
    }), { authorization: "Bearer shared-token", "content-type": "application/json" });

    expect(response.status).toBe(201);
    expect(spy).toHaveBeenCalledWith(response.body.workflow.id, expect.any(String), { workflowStepTimeoutMs: 1000 }, { kind: "api", id: "http:verified-token" });
  });
});
