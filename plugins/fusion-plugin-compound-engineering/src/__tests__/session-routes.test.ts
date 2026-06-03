import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginRouteResponse } from "@fusion/core";
import { createSessionRoutes } from "../routes/session-routes.js";
import { makeHarness, type TestHarness } from "./_harness.js";

/**
 * Routes-level smoke test for the POLLING transport. Exercises validation and
 * the get-session-state read path that clients poll. The orchestrator's live
 * interactive flow is covered by orchestrator-flow.test.ts; here createInter-
 * activeAiSession is absent (non-engine context), so `start` returns a 400 —
 * which is the correct, non-hanging behavior.
 */

let h: TestHarness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.close();
  vi.restoreAllMocks();
});

function route(method: string, path: string) {
  const r = createSessionRoutes().find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`route ${method} ${path} not found`);
  return r;
}

async function call(method: string, path: string, req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  return (await route(method, path).handler(req, ctx)) as PluginRouteResponse;
}

describe("session routes (polling transport)", () => {
  it("exposes start / answer / resume / get-session-state / list", () => {
    const paths = createSessionRoutes().map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        "POST /sessions",
        "POST /sessions/:id/answer",
        "POST /sessions/:id/resume",
        "GET /sessions/:id",
        "GET /sessions",
        "DELETE /sessions/:id",
      ]),
    );
  });

  it("DELETE /sessions/:id discards a session (404 for unknown, gone afterwards, others kept)", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    const keep = store.create({ stage: "brainstorm" });
    const drop = store.create({ stage: "plan" });

    const missing = await call("DELETE", "/sessions/:id", { params: { id: "nope" } }, h.ctx);
    expect(missing.status).toBe(404);

    const deleted = await call("DELETE", "/sessions/:id", { params: { id: drop.id } }, h.ctx);
    expect(deleted.status).toBe(200);
    expect(store.get(drop.id)).toBeUndefined();
    expect(store.get(keep.id)).toBeDefined();
  });

  it("GET /sessions lists every session so a client can manage multiple concurrently", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    store.create({ stage: "brainstorm" });
    store.create({ stage: "plan" });

    const res = await call("GET", "/sessions", { params: {}, query: {} }, h.ctx);
    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions: Array<{ stage: string }> }).sessions;
    expect(sessions.map((s) => s.stage).sort()).toEqual(["brainstorm", "plan"]);
  });

  it("POST /sessions requires a stage", async () => {
    const res = await call("POST", "/sessions", { body: {} }, h.ctx);
    expect(res.status).toBe(400);
  });

  it("POST /sessions without engine interactive factory returns a clean 400 (no hang)", async () => {
    const res = await call("POST", "/sessions", { body: { stage: "brainstorm", message: "go" } }, h.ctx);
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/not available/i);
  });

  it("GET /sessions/:id returns 404 for an unknown id and 200 for a known one", async () => {
    const missing = await call("GET", "/sessions/:id", { params: { id: "nope" } }, h.ctx);
    expect(missing.status).toBe(404);

    // Seed a session directly so the poll route has something to return.
    const { getCeSessionStore } = await import("../session/session-store.js");
    const seeded = getCeSessionStore(h.ctx).create({ stage: "brainstorm" });
    const found = await call("GET", "/sessions/:id", { params: { id: seeded.id } }, h.ctx);
    expect(found.status).toBe(200);
    expect((found.body as { session: { id: string } }).session.id).toBe(seeded.id);
  });

  it("POST /sessions/:id/answer validates questionId and response", async () => {
    const res = await call("POST", "/sessions/:id/answer", { params: { id: "x" }, body: {} }, h.ctx);
    expect(res.status).toBe(400);
  });
});
