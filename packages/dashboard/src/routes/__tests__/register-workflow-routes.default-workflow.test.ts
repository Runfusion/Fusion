// @vitest-environment node

/**
 * FNXC:DefaultWorkflowWriteValidation 2026-10-14-23:58 (RUFU-391):
 * HTTP-status coverage for the dedicated default-workflow endpoint. The verdict itself is pinned at the
 * store seam by `packages/core/src/config/__tests__/default-workflow-write-validation.test.ts`; what is
 * pinned HERE is only the transport mapping of that verdict, which RUFU-391 had to widen: the route used
 * to know exactly one refusal (`not found` → 404), and every refusal the widened store seam adds —
 * deprecated, not-enabled, plugin-gated, fragment — would otherwise reach an operator as a 500 for what
 * is a correctable input. Runs against a real `TaskStore` so the mapping is proved end to end, not
 * against a store double that would merely echo whatever the test handed it.
 */

import express from "express";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { TaskStore, WorkflowIr } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { registerWorkflowRoutes } from "../register-workflow-routes.js";
import { ApiError, sendErrorResponse } from "../../api-error.js";
import { request } from "../../test-request.js";

const MINIMAL_IR = {
  version: "v1",
  name: "custom-default",
  nodes: [{ id: "start", kind: "start" }, { id: "end", kind: "end" }],
  edges: [{ from: "start", to: "end", condition: "success" }],
} as unknown as WorkflowIr;

pgDescribe("PUT /api/project/default-workflow", () => {
  let harness: PgTestHarness;
  let store: TaskStore;
  let app: express.Express;

  beforeEach(async () => {
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

  const put = (body: unknown) =>
    request(app, "PUT", "/api/project/default-workflow", JSON.stringify(body), { "content-type": "application/json" });

  it("accepts a real custom workflow and persists it", async () => {
    const created = await store.createWorkflowDefinition({
      name: "custom-default",
      ir: MINIMAL_IR,
    });

    const res = await put({ workflowId: created.id });

    expect(res.status).toBe(200);
    expect(await store.getDefaultWorkflowId()).toBe(created.id);
  });

  it("answers 404 for an id that does not exist and persists nothing", async () => {
    const before = await store.getDefaultWorkflowId();

    const res = await put({ workflowId: "wf-does-not-exist" });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("'wf-does-not-exist'");
    expect(await store.getDefaultWorkflowId()).toBe(before);
  });

  /*
   * The regression this task exists to close, at the transport layer: a shipped-but-deprecated built-in is
   * a real workflow, so the pre-RUFU-391 route had no branch for it and a refusal from the store seam
   * surfaced as a 500. It must read as a 400 that names the id and the reason.
   */
  it("answers 400 — not 500 — for a shipped built-in that is not an allowed default", async () => {
    const before = await store.getDefaultWorkflowId();

    const res = await put({ workflowId: "builtin:brainstorming" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("'builtin:brainstorming'");
    expect(res.body.error).toContain("default workflow");
    expect(await store.getDefaultWorkflowId()).toBe(before);
  });

  it("answers 400 for a fragment built-in with the project-default sentence", async () => {
    const res = await put({ workflowId: "builtin:pr-workflow" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Workflow 'builtin:pr-workflow' is a fragment and cannot be set as the project default");
  });

  it("accepts null as a clear", async () => {
    await store.setDefaultWorkflowId("builtin:coding");

    const res = await put({ workflowId: null });

    expect(res.status).toBe(200);
    expect((await store.getSettings()).defaultWorkflowId).toBeUndefined();
  });

  it("rejects a non-string, non-null body value", async () => {
    const res = await put({ workflowId: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("workflowId must be a string or null");
  });
});
