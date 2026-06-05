// @vitest-environment node
//
// U13 / KTD-14: HTTP coverage for custom task fields.
//   - PATCH /tasks/:id/custom-fields validates a value patch through the store
//     write authority (updateTaskCustomFields): a valid patch returns 200 with
//     the updated task; an enum violation returns 400 with { fieldId, code,
//     detail }; an unknown field returns 400; a malformed body returns 400.
//   - GET /tasks/board-workflows carries the workflow's `fields` declaration in
//     each described workflow definition (flag ON).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import type { WorkflowIr } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { buildBoardWorkflowsPayload } from "../board-workflows.js";
import { request as REQUEST } from "../../test-request.js";

/** A linear v2 workflow declaring two custom fields (KTD-13). */
function fieldedWorkflow(name: string): WorkflowIr {
  return {
    version: "v2",
    name,
    columns: [
      { id: "c-intake", name: "Intake", traits: [{ trait: "intake" }] },
      { id: "c-run", name: "Run", traits: [{ trait: "wip", config: { limit: 5 } }] },
      { id: "c-done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "c-intake" },
      { id: "end", kind: "end", column: "c-done" },
    ],
    edges: [{ from: "start", to: "end" }],
    fields: [
      {
        id: "severity",
        name: "Severity",
        type: "enum",
        options: [
          { value: "low", label: "Low", color: "#22c55e" },
          { value: "high", label: "High", color: "#ef4444" },
        ],
        render: { placement: "card" },
      },
      { id: "owner", name: "Owner", type: "string", render: { placement: "detail" } },
    ],
  } as WorkflowIr;
}

describe("custom task fields routes (U13/KTD-14)", () => {
  let store: TaskStore;
  let rootDir: string;
  let globalDir: string;
  let app: express.Express;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "cf-route-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "cf-route-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
  });

  afterEach(() => {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  const patch = (path: string, body: unknown) =>
    REQUEST(app, "PATCH", path, JSON.stringify(body), { "content-type": "application/json" });
  const get = (path: string) => REQUEST(app, "GET", path);

  async function taskWithFields() {
    const wf = await store.createWorkflowDefinition({ name: "Fielded", ir: fieldedWorkflow("fielded") });
    const task = await store.createTask({ description: "card" });
    await store.selectTaskWorkflowAndReconcile(task.id, wf.id);
    return { wf, task };
  }

  it("PATCH custom-fields accepts a valid patch and returns the updated task", async () => {
    const { task } = await taskWithFields();
    const res = await patch(`/api/tasks/${task.id}/custom-fields`, {
      customFields: { severity: "high", owner: "alice" },
    });
    expect(res.status).toBe(200);
    const body = res.body as { id: string; customFields: Record<string, unknown> };
    expect(body.id).toBe(task.id);
    expect(body.customFields.severity).toBe("high");
    expect(body.customFields.owner).toBe("alice");
  });

  it("PATCH custom-fields rejects an enum violation with 400 { fieldId, code, detail }", async () => {
    const { task } = await taskWithFields();
    const res = await patch(`/api/tasks/${task.id}/custom-fields`, {
      customFields: { severity: "nope" },
    });
    expect(res.status).toBe(400);
    const details = (res.body as { details?: { fieldId?: string; code?: string; detail?: string } }).details;
    expect(details?.fieldId).toBe("severity");
    expect(details?.code).toBe("enum-violation");
    expect(typeof details?.detail).toBe("string");
  });

  it("PATCH custom-fields rejects an unknown field with 400 unknown-field", async () => {
    const { task } = await taskWithFields();
    const res = await patch(`/api/tasks/${task.id}/custom-fields`, {
      customFields: { nonexistent: "x" },
    });
    expect(res.status).toBe(400);
    const details = (res.body as { details?: { fieldId?: string; code?: string } }).details;
    expect(details?.fieldId).toBe("nonexistent");
    expect(details?.code).toBe("unknown-field");
  });

  it("PATCH custom-fields rejects a malformed body with 400", async () => {
    const { task } = await taskWithFields();
    const res = await patch(`/api/tasks/${task.id}/custom-fields`, { customFields: "not-an-object" });
    expect(res.status).toBe(400);
  });

  it("PATCH custom-fields deletes a value via null", async () => {
    const { task } = await taskWithFields();
    await patch(`/api/tasks/${task.id}/custom-fields`, { customFields: { owner: "alice" } });
    const res = await patch(`/api/tasks/${task.id}/custom-fields`, { customFields: { owner: null } });
    expect(res.status).toBe(200);
    const body = res.body as { customFields: Record<string, unknown> };
    expect(body.customFields.owner).toBeUndefined();
  });

  it("board-workflows payload (flag ON) carries the workflow's fields declaration", async () => {
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
    const { wf, task } = await taskWithFields();
    // Drive the payload builder with the explicit task-id set the route would
    // pass — isolates the fields pass-through from the route's slim-list read
    // (subject to the known startup-slim-memo staleness, see board-workflows-route.test).
    const payload = await buildBoardWorkflowsPayload(store, [task.id]);
    expect(payload.flagEnabled).toBe(true);
    const fielded = payload.workflows.find((w) => w.id === wf.id) as
      | { id: string; fields?: Array<{ id: string; type: string; render?: { placement?: string } }> }
      | undefined;
    expect(fielded?.fields).toBeDefined();
    expect(fielded?.fields?.map((f) => f.id).sort()).toEqual(["owner", "severity"]);
    const severity = fielded?.fields?.find((f) => f.id === "severity");
    expect(severity?.render?.placement).toBe("card");
  });

  it("GET /tasks/board-workflows route returns 200 with flagEnabled true", async () => {
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
    await taskWithFields();
    const res = await get("/api/tasks/board-workflows");
    expect(res.status).toBe(200);
    expect((res.body as { flagEnabled: boolean }).flagEnabled).toBe(true);
  });
});
