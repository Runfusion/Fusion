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

  it("workflowId → created task records workflow selection", async () => {
    const wf = await store.createWorkflowDefinition({ name: "QA", ir: linearIr("qa") });

    const res = await post("/api/tasks", { description: "with workflow", workflowId: wf.id });
    expect(res.status).toBe(201);
    const created = res.body as { id: string };

    const detail = await store.getTask(created.id);
    expect(detail.enabledWorkflowSteps ?? []).toEqual([]);
    expect(store.getTaskWorkflowSelection(created.id)).toEqual({ workflowId: wf.id, stepIds: [] });
  });

  it("workflowId plus enabledWorkflowSteps → created task keeps explicit workflow selection", async () => {
    const res = await post("/api/tasks", {
      description: "stepwise with toggles",
      workflowId: "builtin:stepwise-coding",
      enabledWorkflowSteps: ["code-review"],
    });
    expect(res.status).toBe(201);
    const created = res.body as { id: string };

    const detail = await store.getTask(created.id);
    expect(detail.enabledWorkflowSteps ?? []).toEqual(["code-review"]);
    expect(store.getTaskWorkflowSelection(created.id)).toEqual({
      workflowId: "builtin:stepwise-coding",
      stepIds: ["code-review"],
    });
  });

  it("workflowId plus empty enabledWorkflowSteps → disables default optional groups and keeps selection", async () => {
    const res = await post("/api/tasks", {
      description: "coding with optional groups off",
      workflowId: "builtin:coding",
      enabledWorkflowSteps: [],
    });
    expect(res.status).toBe(201);
    const created = res.body as { id: string };

    const detail = await store.getTask(created.id);
    expect(detail.enabledWorkflowSteps ?? []).toEqual([]);
    expect(store.getTaskWorkflowSelection(created.id)).toEqual({
      workflowId: "builtin:coding",
      stepIds: [],
    });
  });

  it.each([
    ["default coding", "builtin:coding", ["plan-review", "code-review"]],
    ["legacy coding", "builtin:legacy-coding", ["code-review"]],
    ["coding per-step review", "builtin:stepwise-coding", ["plan-review", "code-review"]],
  ])("%s workflow create/select/resolve works end to end", async (_label, workflowId, defaultSteps) => {
    const res = await post("/api/tasks", {
      description: `exercise ${workflowId}`,
      workflowId,
    });
    expect(res.status).toBe(201);
    const created = res.body as { id: string };

    const detail = await store.getTask(created.id);
    expect(detail.enabledWorkflowSteps ?? []).toEqual(defaultSteps);
    expect(store.getTaskWorkflowSelection(created.id)).toEqual({
      workflowId,
      stepIds: defaultSteps,
    });
    const definition = await store.getWorkflowDefinition(workflowId);
    expect(definition?.id).toBe(workflowId);
    expect(definition?.kind).toBe("workflow");
  });

  it("unavailable Compound engineering workflow → 4xx instead of default coding fallback", async () => {
    const before = (await store.listTasks({ includeArchived: true })).length;

    const res = await post("/api/tasks", {
      description: "compound unavailable",
      workflowId: "builtin:compound-engineering",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(String((res.body as { error?: unknown }).error ?? "")).toContain("builtin:compound-engineering");
    const after = (await store.listTasks({ includeArchived: true })).length;
    expect(after).toBe(before);
  });

  it("registered Compound engineering plugin → created task keeps Compound workflow selection", async () => {
    await store.getPluginStore().registerPlugin({
      manifest: {
        id: "fusion-plugin-compound-engineering",
        name: "Compound Engineering",
        version: "0.0.0",
      },
      path: rootDir,
    });

    const res = await post("/api/tasks", {
      description: "compound available",
      workflowId: "builtin:compound-engineering",
    });
    expect(res.status).toBe(201);
    const created = res.body as { id: string };

    expect(store.getTaskWorkflowSelection(created.id)?.workflowId).toBe("builtin:compound-engineering");
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
