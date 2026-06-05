// @vitest-environment node
//
// U5/R9/R10 — HTTP integration coverage for GET /api/workflows/:id/export and
// POST /api/workflows/import. Exercises the routes end-to-end against a REAL
// TaskStore (no store-method mocking — mock-masked dead-wiring learning): the
// import route must validate the envelope at the write boundary and persist a
// fresh definition only when every gate passes.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, SCHEMA_VERSION, isBuiltinWorkflowId } from "@fusion/core";
import type { WorkflowIr } from "@fusion/core";
import { registerWorkflowRoutes } from "../register-workflow-routes.js";
import { ApiError, sendErrorResponse } from "../../api-error.js";
import { request } from "../../test-request.js";

describe("workflow import/export routes (U5/R9/R10)", () => {
  let store: TaskStore;
  let rootDir: string;
  let globalDir: string;
  let app: express.Express;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "wf-impexp-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "wf-impexp-global-"));
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

  const get = (path: string) => request(app, "GET", path);
  const postJson = (path: string, body: unknown) =>
    request(app, "POST", path, JSON.stringify(body), { "Content-Type": "application/json" });

  /** A minimal valid v1 linear IR with one prompt node. */
  function linearIr(overrides?: { nodeConfig?: Record<string, unknown> }): WorkflowIr {
    return {
      version: "v1",
      name: "graph",
      nodes: [
        { id: "start", kind: "start" },
        { id: "n1", kind: "prompt", config: { name: "Do it", prompt: "go", ...(overrides?.nodeConfig ?? {}) } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "n1", condition: "success" },
        { from: "n1", to: "end", condition: "success" },
      ],
    } as WorkflowIr;
  }

  function envelope(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
    return {
      fusionWorkflowExport: 1,
      schemaVersion: SCHEMA_VERSION,
      kind: "workflow",
      name: "Imported flow",
      description: "desc",
      ir: linearIr(),
      layout: { n1: { x: 10, y: 20 } },
      ...overrides,
    };
  }

  async function userDefs() {
    return (await store.listWorkflowDefinitions()).filter((w) => !isBuiltinWorkflowId(w.id));
  }

  it("round-trips export → import reproducing ir/layout/description and kind", async () => {
    const created = await store.createWorkflowDefinition({
      name: "Source flow",
      description: "round trip",
      kind: "fragment",
      ir: linearIr(),
      layout: { n1: { x: 5, y: 6 } },
    });

    const exp = await get(`/api/workflows/${created.id}/export`);
    expect(exp.status).toBe(200);
    const env = exp.body as Record<string, unknown>;
    expect(env.fusionWorkflowExport).toBe(1);
    expect(env.schemaVersion).toBe(SCHEMA_VERSION);
    expect(env.kind).toBe("fragment");

    const imp = await postJson("/api/workflows/import", env);
    expect(imp.status).toBe(201);
    const body = imp.body as { workflow: { id: string; kind: string; description: string; layout: unknown; ir: WorkflowIr } };
    expect(body.workflow.id).not.toBe(created.id);
    expect(body.workflow.kind).toBe("fragment");
    expect(body.workflow.description).toBe("round trip");
    expect(body.workflow.layout).toEqual({ n1: { x: 5, y: 6 } });
    // Semantic IR equality: same node ids/kinds.
    expect(body.workflow.ir.nodes.map((n) => n.id)).toEqual(created.ir.nodes.map((n) => n.id));
  });

  it("suffixes the name on collision", async () => {
    await store.createWorkflowDefinition({ name: "Imported flow", ir: linearIr() });
    const res = await postJson("/api/workflows/import", envelope());
    expect(res.status).toBe(201);
    const body = res.body as { workflow: { name: string } };
    expect(body.workflow.name).toBe("Imported flow (imported)");
  });

  it("exporting a built-in yields a fresh, non-builtin, editable id on import", async () => {
    const exp = await get(`/api/workflows/builtin:coding/export`);
    expect(exp.status).toBe(200);
    const imp = await postJson("/api/workflows/import", exp.body);
    expect(imp.status).toBe(201);
    const body = imp.body as { workflow: { id: string } };
    expect(isBuiltinWorkflowId(body.workflow.id)).toBe(false);
    // Editable: an update succeeds (built-ins reject).
    await expect(store.updateWorkflowDefinition(body.workflow.id, { description: "edited" })).resolves.toBeTruthy();
  });

  it("rejects a missing envelope marker with 400 and persists nothing", async () => {
    const res = await postJson("/api/workflows/import", { ...envelope(), fusionWorkflowExport: undefined });
    expect(res.status).toBe(400);
    expect(await userDefs()).toHaveLength(0);
  });

  it("rejects a malformed IR with 422 carrying the parser message and zero writes", async () => {
    const res = await postJson("/api/workflows/import", envelope({ ir: { version: "v1", nodes: "nope" } }));
    expect(res.status).toBe(422);
    expect((res.body as { error?: string }).error).toBeTruthy();
    expect(await userDefs()).toHaveLength(0);
  });

  it("rejects an unknown trait with 422 naming the trait", async () => {
    const v2Ir: WorkflowIr = {
      version: "v2",
      name: "traited",
      columns: [{ id: "c1", name: "C1", traits: [{ trait: "totally-bogus-trait" }] }],
      nodes: [
        { id: "start", kind: "start", column: "c1" },
        { id: "end", kind: "end", column: "c1" },
      ],
      edges: [{ from: "start", to: "end", condition: "success" }],
    } as WorkflowIr;
    const res = await postJson("/api/workflows/import", envelope({ ir: v2Ir }));
    expect(res.status).toBe(422);
    expect((res.body as { error: string }).error).toContain("totally-bogus-trait");
    expect(await userDefs()).toHaveLength(0);
  });

  it("rejects a newer schemaVersion with 409 naming both versions", async () => {
    const res = await postJson("/api/workflows/import", envelope({ schemaVersion: 9999 }));
    expect(res.status).toBe(409);
    const msg = (res.body as { error: string }).error;
    expect(msg).toContain("9999");
    expect(msg).toContain(String(SCHEMA_VERSION));
    expect(await userDefs()).toHaveLength(0);
  });

  it("accepts an older-or-equal schemaVersion with 201", async () => {
    const older = await postJson("/api/workflows/import", envelope({ schemaVersion: 1, name: "Older" }));
    expect(older.status).toBe(201);
    const equal = await postJson("/api/workflows/import", envelope({ name: "Equal" }));
    expect(equal.status).toBe(201);
  });

  it("strips cliSkipApproval from node config and flags it in the response", async () => {
    const res = await postJson(
      "/api/workflows/import",
      envelope({ ir: linearIr({ nodeConfig: { cliSkipApproval: true, autoApprove: true } }) }),
    );
    expect(res.status).toBe(201);
    const body = res.body as { workflow: { id: string; ir: WorkflowIr }; strippedApprovalFlags: boolean };
    expect(body.strippedApprovalFlags).toBe(true);
    const node = body.workflow.ir.nodes.find((n) => n.id === "n1");
    expect(node?.config?.cliSkipApproval).toBeUndefined();
    expect(node?.config?.autoApprove).toBeUndefined();
    // Persisted definition also lacks the flags.
    const persisted = await store.getWorkflowDefinition(body.workflow.id);
    const pnode = persisted?.ir.nodes.find((n) => n.id === "n1");
    expect(pnode?.config?.cliSkipApproval).toBeUndefined();
  });

  it("warns (non-blocking) when a script node references an unknown scriptName", async () => {
    const scriptIr = linearIr();
    (scriptIr.nodes[1] as { kind: string }).kind = "script";
    (scriptIr.nodes[1] as { config: Record<string, unknown> }).config = { name: "Run", scriptName: "ghost-script" };
    const res = await postJson("/api/workflows/import", envelope({ ir: scriptIr }));
    expect(res.status).toBe(201);
    const body = res.body as { warnings: string[] };
    expect(body.warnings.some((w) => w.includes("ghost-script"))).toBe(true);
  });
});
