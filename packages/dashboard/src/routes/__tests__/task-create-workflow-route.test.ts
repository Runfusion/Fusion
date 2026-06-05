// @vitest-environment node
//
// U6/R3/KTD-4: HTTP integration coverage for the create-time `workflowId`
// parameter on POST /tasks. Exercises the route end-to-end against a REAL
// TaskStore via createApiRoutes:
//   - workflowId → task's enabledWorkflowSteps populated atomically (the
//     materialization happens inside createTask, not via a post-create select)
//   - fragment id → 4xx (rejected before the task row is created)
//   - unknown id → 4xx

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import type { WorkflowIr } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

/** Linear v1 workflow with two pre-merge steps that compiles + selects cleanly. */
function linearIr(name: string): WorkflowIr {
  return {
    version: "v1",
    name,
    nodes: [
      { id: "start", kind: "start" },
      { id: "lint", kind: "gate", config: { name: "Lint", scriptName: "lint" } },
      { id: "spec", kind: "prompt", config: { name: "Spec", prompt: "check" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "lint", condition: "success" },
      { from: "lint", to: "spec", condition: "success" },
      { from: "spec", to: "end", condition: "success" },
    ],
  };
}

/** Single-node fragment IR (not selectable for a task). */
function fragmentIr(): WorkflowIr {
  return {
    version: "v1",
    name: "frag",
    nodes: [
      { id: "start", kind: "start" },
      { id: "step-1", kind: "prompt", config: { name: "Doc", prompt: "doc it" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "step-1", condition: "success" },
      { from: "step-1", to: "end", condition: "success" },
    ],
  };
}

describe("POST /tasks workflowId (U6/R3)", () => {
  let store: TaskStore;
  let rootDir: string;
  let globalDir: string;
  let app: express.Express;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "task-wf-route-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "task-wf-route-global-"));
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

  const post = (path: string, body: unknown) =>
    REQUEST(app, "POST", path, JSON.stringify(body), { "content-type": "application/json" });

  it("workflowId → created task has populated enabledWorkflowSteps", async () => {
    const wf = await store.createWorkflowDefinition({ name: "QA", ir: linearIr("qa") });

    const res = await post("/api/tasks", { description: "with workflow", workflowId: wf.id });
    expect(res.status).toBe(201);
    const created = res.body as { id: string };

    const detail = await store.getTask(created.id);
    expect(detail.enabledWorkflowSteps).toHaveLength(2);
    expect(store.getTaskWorkflowSelection(created.id)?.workflowId).toBe(wf.id);
  });

  it("workflowId: null → task created with no workflow steps", async () => {
    const def = await store.createWorkflowDefinition({ name: "Default", ir: linearIr("def") });
    await store.setDefaultWorkflowId(def.id);

    const res = await post("/api/tasks", { description: "no workflow", workflowId: null });
    expect(res.status).toBe(201);
    const created = res.body as { id: string };

    const detail = await store.getTask(created.id);
    expect(detail.enabledWorkflowSteps ?? []).toHaveLength(0);
    expect(store.getTaskWorkflowSelection(created.id)).toBeUndefined();
  });

  it("fragment id → 4xx, no task created", async () => {
    const frag = await store.createWorkflowDefinition({ name: "Frag", ir: fragmentIr(), kind: "fragment" });
    const before = (await store.listTasks({ includeArchived: true })).length;

    const res = await post("/api/tasks", { description: "frag", workflowId: frag.id });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const after = (await store.listTasks({ includeArchived: true })).length;
    expect(after).toBe(before);
  });

  it("unknown id → 4xx, no task created", async () => {
    const before = (await store.listTasks({ includeArchived: true })).length;

    const res = await post("/api/tasks", { description: "bad", workflowId: "WF-404" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const after = (await store.listTasks({ includeArchived: true })).length;
    expect(after).toBe(before);
  });
});
