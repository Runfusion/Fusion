// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { TaskStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../../core/src/__test-utils__/pg-test-harness.js";
import type { WorkflowIr } from "@fusion/core";
import { registerWorkflowRoutes } from "../register-workflow-routes.js";
import { ApiError, sendErrorResponse } from "../../api-error.js";
import { request } from "../../test-request.js";

function linearIr(): WorkflowIr {
  return {
    version: "v1",
    name: "valid",
    nodes: [
      { id: "start", kind: "start" },
      { id: "end", kind: "end" },
    ],
    edges: [{ from: "start", to: "end", condition: "success" }],
  } as WorkflowIr;
}

pgDescribe("POST /api/workflows/validate", () => {
  let harness: PgTestHarness;
  let store: TaskStore;
  let app: express.Express;

  beforeEach(async () => {
    // FNXC:PostgresCutover 2026-07-16-06:30: validation routes exercise the
    // production async persistence contract rather than removed SQLite fixtures.
    harness = await createTaskStoreForTest();
    store = harness.store;

    app = express();
    app.use(express.json());
    const router = express.Router();
    registerWorkflowRoutes({
      router,
      getProjectContext: async () => ({ store, engine: undefined, projectId: undefined }),
      rethrowAsApiError: (err: unknown) => {
        throw err instanceof ApiError ? err : new ApiError(500, err instanceof Error ? err.message : String(err));
      },
      options: {},
    } as unknown as Parameters<typeof registerWorkflowRoutes>[0]);
    app.use("/api", router);
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof ApiError) sendErrorResponse(res, err.statusCode, err.message, { details: err.details });
      else sendErrorResponse(res, 500, err instanceof Error ? err.message : String(err));
    });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  async function userDefCount(): Promise<number> {
    return (await store.listWorkflowDefinitions()).filter((wf) => wf.kind === "custom").length;
  }

  async function postValidate(body: unknown) {
    return request(app, "POST", "/api/workflows/validate", JSON.stringify(body), { "content-type": "application/json" });
  }

  it("returns valid true for an inline IR without persisting a workflow", async () => {
    const before = await userDefCount();
    const res = await postValidate({ ir: linearIr() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });
    expect(await userDefCount()).toBe(before);
  });

  it("returns typed validation errors with 200 for malformed IR", async () => {
    const before = await userDefCount();
    const ir = { ...linearIr(), nodes: [{ id: "start", kind: "start" }, { id: "start2", kind: "start" }, { id: "end", kind: "end" }] };
    const res = await postValidate({ ir });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors[0]).toMatchObject({ type: "workflow-ir" });
    expect(await userDefCount()).toBe(before);
  });

  it("validates an existing workflow by id without mutating it", async () => {
    const created = await store.createWorkflowDefinition({ name: "Existing", ir: linearIr() });
    const before = await userDefCount();
    const res = await postValidate({ workflowId: created.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });
    expect(await userDefCount()).toBe(before);
  });

  it("uses 4xx only for request errors", async () => {
    expect((await postValidate({})).status).toBe(400);
    expect((await postValidate({ workflowId: "WF-NOPE" })).status).toBe(404);
  });
});
