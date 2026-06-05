// @vitest-environment node
//
// U7/R11/KTD-6 — HTTP integration coverage for POST /api/workflows/design.
// Exercises the route end-to-end against a REAL TaskStore (no store-method
// mocking) with a FAKE createFnAgent injected via __setCreateFnAgentForDesign:
// the fake captures the user prompt and returns canned text (NO model calls).
// The route must JSON-extract, parse, compile-triage, strip approval flags, and
// persist NOTHING — it returns the IR and the client decides.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, isBuiltinWorkflowId } from "@fusion/core";
import type { WorkflowIr } from "@fusion/core";
import {
  registerWorkflowRoutes,
  __setCreateFnAgentForDesign,
  __resetCreateFnAgentForDesign,
  __resetDesignRateLimit,
} from "../register-workflow-routes.js";
import { ApiError, sendErrorResponse } from "../../api-error.js";
import { request } from "../../test-request.js";

/** Captures the prompt the route fed the agent and returns canned `text`. */
function makeFakeAgent(text: string) {
  const captured: { systemPrompt?: string; userPrompt?: string } = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory: any = async (opts: any) => {
    captured.systemPrompt = opts.systemPrompt;
    let textListener: ((delta: string) => void) | undefined;
    const session = {
      on(_event: "text", listener: (delta: string) => void) {
        textListener = listener;
      },
      async prompt(userPrompt: string) {
        captured.userPrompt = userPrompt;
        textListener?.(text);
      },
      dispose() {},
    };
    return { session };
  };
  return { factory, captured };
}

/** A fake agent whose prompt rejects; tracks whether dispose() was called so we
 *  can assert the route releases the session even when the model turn throws. */
function makeRejectingAgent() {
  const state = { disposed: false };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory: any = async () => {
    const session = {
      on(_event: "text", _listener: (delta: string) => void) {},
      async prompt() {
        throw new Error("model turn failed");
      },
      dispose() {
        state.disposed = true;
      },
    };
    return { session };
  };
  return { factory, state };
}

/** A minimal valid v1 linear IR (start → prompt → end). */
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

/** A branching IR: one node with two `success` edges → triggers the compiler's
 *  deferred-interpreter suffix (interpreterOnly). */
function branchingIr(): WorkflowIr {
  return {
    version: "v1",
    name: "branchy",
    nodes: [
      { id: "start", kind: "start" },
      { id: "a", kind: "prompt", config: { name: "A", prompt: "a" } },
      { id: "b", kind: "prompt", config: { name: "B", prompt: "b" } },
      { id: "c", kind: "prompt", config: { name: "C", prompt: "c" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "a", condition: "success" },
      { from: "a", to: "b", condition: "success" },
      { from: "a", to: "c", condition: "success" },
      { from: "b", to: "end", condition: "success" },
      { from: "c", to: "end", condition: "success" },
    ],
  } as WorkflowIr;
}

describe("POST /api/workflows/design (U7/R11/KTD-6)", () => {
  let store: TaskStore;
  let rootDir: string;
  let globalDir: string;
  let app: express.Express;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "wf-design-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "wf-design-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
    __resetDesignRateLimit();

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
    __resetCreateFnAgentForDesign();
    __resetDesignRateLimit();
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  const postJson = (path: string, body: unknown) =>
    request(app, "POST", path, JSON.stringify(body), { "Content-Type": "application/json" });

  async function userDefCount() {
    return (await store.listWorkflowDefinitions()).filter((w) => !isBuiltinWorkflowId(w.id)).length;
  }

  it("valid linear IR → 200 {ir, interpreterOnly:false} with layout", async () => {
    const { factory } = makeFakeAgent(JSON.stringify(linearIr()));
    __setCreateFnAgentForDesign(factory);

    const res = await postJson("/api/workflows/design", { prompt: "a coding flow" });
    expect(res.status).toBe(200);
    expect(res.body.interpreterOnly).toBe(false);
    expect(res.body.ir.nodes).toHaveLength(3);
    expect(res.body.layout).toBeTruthy();
    expect(Object.keys(res.body.layout).length).toBeGreaterThan(0);
    expect(res.body.strippedApprovalFlags).toBe(false);
  });

  it("fenced + prose-wrapped JSON → still extracted and 200", async () => {
    const wrapped = `Sure! Here is your workflow:\n\n\`\`\`json\n${JSON.stringify(linearIr())}\n\`\`\`\n\nLet me know if you want changes.`;
    const { factory } = makeFakeAgent(wrapped);
    __setCreateFnAgentForDesign(factory);

    const res = await postJson("/api/workflows/design", { prompt: "make a flow" });
    expect(res.status).toBe(200);
    expect(res.body.ir.nodes).toHaveLength(3);
    expect(res.body.interpreterOnly).toBe(false);
  });

  it("branching IR → 200 {interpreterOnly:true}", async () => {
    const { factory } = makeFakeAgent(JSON.stringify(branchingIr()));
    __setCreateFnAgentForDesign(factory);

    const res = await postJson("/api/workflows/design", { prompt: "branch it" });
    expect(res.status).toBe(200);
    expect(res.body.interpreterOnly).toBe(true);
    expect(res.body.ir.nodes).toHaveLength(5);
  });

  it("invalid JSON → 422, nothing persisted", async () => {
    const { factory } = makeFakeAgent("this is not json at all");
    __setCreateFnAgentForDesign(factory);

    const before = await userDefCount();
    const res = await postJson("/api/workflows/design", { prompt: "x" });
    expect(res.status).toBe(422);
    expect(await userDefCount()).toBe(before);
  });

  it("prompt rejects → 5xx but session is still disposed (no leak)", async () => {
    const { factory, state } = makeRejectingAgent();
    __setCreateFnAgentForDesign(factory);

    const before = await userDefCount();
    const res = await postJson("/api/workflows/design", { prompt: "x" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(state.disposed).toBe(true);
    expect(await userDefCount()).toBe(before);
  });

  it("JSON failing parseWorkflowIr (missing start) → 422 with parser message, nothing persisted", async () => {
    const noStart = {
      version: "v1",
      name: "broken",
      nodes: [{ id: "end", kind: "end" }],
      edges: [],
    };
    const { factory } = makeFakeAgent(JSON.stringify(noStart));
    __setCreateFnAgentForDesign(factory);

    const before = await userDefCount();
    const res = await postJson("/api/workflows/design", { prompt: "x" });
    expect(res.status).toBe(422);
    expect(String(res.body.error ?? res.body.message ?? "")).toMatch(/start/i);
    expect(await userDefCount()).toBe(before);
  });

  it("cliSkipApproval on a node → returned IR lacks it, strippedApprovalFlags:true", async () => {
    const { factory } = makeFakeAgent(
      JSON.stringify(linearIr({ nodeConfig: { cliSkipApproval: true } })),
    );
    __setCreateFnAgentForDesign(factory);

    const res = await postJson("/api/workflows/design", { prompt: "x" });
    expect(res.status).toBe(200);
    expect(res.body.strippedApprovalFlags).toBe(true);
    const node = res.body.ir.nodes.find((n: { id: string }) => n.id === "n1");
    expect(node.config.cliSkipApproval).toBeUndefined();
  });

  it("workflowId flow: base IR is read server-side and folded into the agent prompt", async () => {
    const seeded = await store.createWorkflowDefinition({
      name: "Base flow",
      description: "",
      ir: linearIr(),
      layout: {},
    });
    const { factory, captured } = makeFakeAgent(JSON.stringify(linearIr()));
    __setCreateFnAgentForDesign(factory);

    const res = await postJson("/api/workflows/design", {
      prompt: "add a review step",
      workflowId: seeded.id,
    });
    expect(res.status).toBe(200);
    // The fake agent received the persisted base IR in its prompt.
    expect(captured.userPrompt).toContain("BASE WORKFLOW IR");
    expect(captured.userPrompt).toContain("\"kind\": \"start\"");
    expect(captured.userPrompt).toContain("add a review step");
  });

  it("unknown workflowId → 404", async () => {
    const { factory } = makeFakeAgent(JSON.stringify(linearIr()));
    __setCreateFnAgentForDesign(factory);

    const res = await postJson("/api/workflows/design", {
      prompt: "x",
      workflowId: "does-not-exist",
    });
    expect(res.status).toBe(404);
  });

  it("11th call within the window → 429", async () => {
    const { factory } = makeFakeAgent(JSON.stringify(linearIr()));
    __setCreateFnAgentForDesign(factory);

    for (let i = 0; i < 10; i++) {
      const ok = await postJson("/api/workflows/design", { prompt: `req ${i}` });
      expect(ok.status).toBe(200);
    }
    const limited = await postJson("/api/workflows/design", { prompt: "one too many" });
    expect(limited.status).toBe(429);
  });

  it("over-length prompt → 400", async () => {
    const { factory } = makeFakeAgent(JSON.stringify(linearIr()));
    __setCreateFnAgentForDesign(factory);

    const res = await postJson("/api/workflows/design", { prompt: "x".repeat(4001) });
    expect(res.status).toBe(400);
  });

  it("empty prompt → 400", async () => {
    const { factory } = makeFakeAgent(JSON.stringify(linearIr()));
    __setCreateFnAgentForDesign(factory);

    const res = await postJson("/api/workflows/design", { prompt: "   " });
    expect(res.status).toBe(400);
  });
});
