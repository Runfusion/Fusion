import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateInteractiveAiSessionFactory, InteractiveAiSessionEvent, PlanningQuestion, PluginContext, PluginRouteResponse } from "@fusion/core";
import { createSessionRoutes } from "../routes/session-routes.js";
import { makeHarness, makeScriptedSession, scriptedFactory, type TestHarness } from "./_harness.js";

/**
 * Routes-level smoke test for the POLLING transport. Exercises validation and
 * the get-session-state read path that clients poll. The orchestrator's live
 * interactive flow is covered by orchestrator-flow.test.ts; here createInter-
 * activeAiSession is absent (non-engine context), so `start` returns a 400 —
 * which is the correct, non-hanging behavior.
 */

const DEBUG_OPENING_MESSAGE = "Start the Debug stage.";
const DEBUG_PROTOCOL_SENTINEL = "translate any loaded-skill instruction";

const QUESTION: PlanningQuestion = {
  id: "q1",
  type: "single_select",
  question: "Which direction?",
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
};

let h: TestHarness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.close();
  vi.restoreAllMocks();
});

function debugProtocolSensitiveFactory(question: PlanningQuestion): CreateInteractiveAiSessionFactory {
  return vi.fn(async (options) => {
    const hasConflictOverride = options.systemPrompt.includes(DEBUG_PROTOCOL_SENTINEL);
    const event: InteractiveAiSessionEvent = hasConflictOverride
      ? { type: "question", data: question }
      : {
          type: "error",
          data: { message: "Failed to parse agent response: AI returned no valid JSON." },
        };
    return { session: makeScriptedSession([event]) };
  });
}

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
        "POST /sessions/:id/cancel",
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

  it("POST /sessions/:id/cancel interrupts an in-flight session", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    const created = store.update(store.create({ stage: "brainstorm" }).id, { status: "active" })!;

    const res = await call("POST", "/sessions/:id/cancel", { params: { id: created.id } }, h.ctx);

    expect(res.status).toBe(200);
    const session = (res.body as { session: { status: string; error: string | null } }).session;
    expect(session.status).toBe("interrupted");
    expect(session.error).toBe("Cancelled by user");
  });

  it("POST /sessions/:id/cancel returns 404 for an unknown session", async () => {
    const res = await call("POST", "/sessions/:id/cancel", { params: { id: "nope" } }, h.ctx);

    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/not found/i);
  });

  it("POST /sessions/:id/cancel is idempotent for terminal sessions", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    const created = store.update(store.create({ stage: "brainstorm" }).id, { status: "completed" })!;

    const res = await call("POST", "/sessions/:id/cancel", { params: { id: created.id } }, h.ctx);

    expect(res.status).toBe(200);
    const session = (res.body as { session: { status: string; error: string | null } }).session;
    expect(session.status).toBe("completed");
    expect(session.error).toBeNull();
    expect(store.get(created.id)!.status).toBe("completed");
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

  it("GET /sessions scopes every session consumer to the requested project", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    const projectA = store.create({ stage: "brainstorm", projectId: "project-a" });
    store.create({ stage: "plan", projectId: "project-b" });
    store.create({ stage: "debug" });

    const res = await call("GET", "/sessions", { params: {}, query: { projectId: "project-a" } }, h.ctx);

    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions: Array<{ id: string; projectId: string | null }> }).sessions;
    expect(sessions).toEqual([expect.objectContaining({ id: projectA.id, projectId: "project-a" })]);
  });

  it("GET /sessions keeps error, interrupted, awaiting_input, active, and completed rows independently manageable", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    const error = store.update(store.create({ stage: "debug" }).id, {
      status: "error",
      error: "Failed to parse agent response: AI returned no valid JSON.",
    })!;
    const interrupted = store.update(store.create({ stage: "plan" }).id, {
      status: "interrupted",
      error: "Cancelled by user",
    })!;
    const awaiting = store.update(store.create({ stage: "brainstorm" }).id, {
      status: "awaiting_input",
      currentQuestion: QUESTION,
    })!;
    const active = store.update(store.create({ stage: "strategy", turnIntervalMs: 60_000 }).id, { status: "active" })!;
    const completed = store.update(store.create({ stage: "work" }).id, { status: "completed" })!;

    const res = await call("GET", "/sessions", { params: {}, query: {} }, h.ctx);

    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions: Array<{ id: string; status: string; error: string | null }> }).sessions;
    expect(sessions.map((s) => [s.id, s.status, s.error])).toEqual(
      expect.arrayContaining([
        [error.id, "error", "Failed to parse agent response: AI returned no valid JSON."],
        [interrupted.id, "interrupted", "Cancelled by user"],
        [awaiting.id, "awaiting_input", null],
        [active.id, "active", null],
        [completed.id, "completed", null],
      ]),
    );

    const deleted = await call("DELETE", "/sessions/:id", { params: { id: error.id } }, h.ctx);
    expect(deleted.status).toBe(200);
    expect(store.get(error.id)).toBeUndefined();
    expect(store.get(completed.id)).toBeDefined();
  });

  it("GET /sessions recovers stale active rows that have no live route handle", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    const zombie = store.create({ stage: "strategy", turnIntervalMs: 1 });
    store.update(zombie.id, {
      status: "active",
      currentQuestion: null,
      lastActivityAt: Date.now() - 10_000,
    });

    const res = await call("GET", "/sessions", { params: {}, query: {} }, h.ctx);

    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions: Array<{ id: string; status: string; error: string | null }> }).sessions;
    expect(sessions.find((s) => s.id === zombie.id)).toMatchObject({
      status: "interrupted",
      error: "Session interrupted — progress preserved, resume to continue",
    });
    expect(store.get(zombie.id)).toMatchObject({
      status: "interrupted",
      error: "Session interrupted — progress preserved, resume to continue",
    });
  });

  it("GET /sessions/:id recovers a stale active row before returning it", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    const zombie = store.create({ stage: "strategy", turnIntervalMs: 1 });
    store.update(zombie.id, {
      status: "active",
      currentQuestion: null,
      lastActivityAt: Date.now() - 10_000,
    });

    const res = await call("GET", "/sessions/:id", { params: { id: zombie.id } }, h.ctx);

    expect(res.status).toBe(200);
    expect((res.body as { session: { status: string; error: string | null } }).session).toMatchObject({
      status: "interrupted",
      error: "Session interrupted — progress preserved, resume to continue",
    });
    expect(store.get(zombie.id)).toMatchObject({
      status: "interrupted",
      error: "Session interrupted — progress preserved, resume to continue",
    });
  });

  it("POST /sessions requires a stage", async () => {
    const res = await call("POST", "/sessions", { body: {} }, h.ctx);
    expect(res.status).toBe(400);
  });

  it("POST /sessions starts debug detached and polling observes a protocol question instead of parse error", async () => {
    const question: PlanningQuestion = {
      id: "debug-scope",
      type: "text",
      question: "What bug or failing behavior should I investigate?",
    };
    h.ctx.createInteractiveAiSession = debugProtocolSensitiveFactory(question);

    const started = await call(
      "POST",
      "/sessions",
      { body: { stage: "debug", message: DEBUG_OPENING_MESSAGE } },
      h.ctx,
    );

    expect(started.status).toBe(201);
    const sessionId = (started.body as { session: { id: string; status: string; error: string | null } }).session.id;
    expect((started.body as { session: { status: string } }).session.status).toBe("launching");

    await new Promise((resolve) => setImmediate(resolve));

    const polled = await call("GET", "/sessions/:id", { params: { id: sessionId } }, h.ctx);
    expect(polled.status).toBe(200);
    expect((polled.body as { session: { status: string; error: string | null; currentQuestion: PlanningQuestion } }).session).toMatchObject({
      status: "awaiting_input",
      error: null,
      currentQuestion: question,
    });
    expect(
      (polled.body as { session: { error: string | null } }).session.error ?? "",
    ).not.toContain("AI returned no valid JSON");
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

  it("POST /sessions/:id/answer rehydrates an old awaiting_input session instead of returning call-resume-first", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    const created = store.create({ stage: "brainstorm" });
    store.appendHistory(created.id, { role: "user", text: "kick off", at: new Date().toISOString() });
    store.appendHistory(created.id, {
      role: "agent",
      text: JSON.stringify({ question: QUESTION }),
      at: new Date().toISOString(),
    });
    store.update(created.id, { status: "awaiting_input", currentQuestion: QUESTION });

    h.ctx.createInteractiveAiSession = scriptedFactory(
      makeScriptedSession([
        { type: "question", data: QUESTION },
        { type: "complete", data: { artifact: "# Done\n" } },
      ]),
    );

    const res = await call(
      "POST",
      "/sessions/:id/answer",
      { params: { id: created.id }, body: { questionId: "q1", response: "a" } },
      h.ctx,
    );
    expect(res.status).toBe(200);
    expect((res.body as { session: { status: string } }).session.status).toBe("active");

    await new Promise((resolve) => setImmediate(resolve));
    expect(store.get(created.id)!.status).toBe("completed");
  });

  it("POST /sessions/:id/answer returns an honest no-factory error without corrupting an old awaiting_input session", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    const created = store.create({ stage: "brainstorm" });
    store.appendHistory(created.id, { role: "user", text: "kick off", at: new Date().toISOString() });
    store.appendHistory(created.id, {
      role: "agent",
      text: JSON.stringify({ question: QUESTION }),
      at: new Date().toISOString(),
    });
    store.update(created.id, { status: "awaiting_input", currentQuestion: QUESTION });

    const res = await call(
      "POST",
      "/sessions/:id/answer",
      { params: { id: created.id }, body: { questionId: "q1", response: "a" } },
      h.ctx,
    );
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/cannot be continued in this process/i);
    expect((res.body as { error: string }).error).not.toMatch(/call resume\(\) first/i);
    const after = store.get(created.id)!;
    expect(after.status).toBe("awaiting_input");
    expect(after.currentQuestion?.id).toBe("q1");
  });
});
