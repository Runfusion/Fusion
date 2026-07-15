import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CreateInteractiveAiSessionFactory, InteractiveAiSessionEvent, PlanningQuestion, PluginContext, PluginRouteResponse } from "@fusion/core";
import { createSessionRoutes } from "../routes/session-routes.js";
import { makeHarness, makeScriptedSession, pgDescribe, scriptedFactory, type TestHarness } from "./_harness.js";

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
beforeEach(async () => {
  h = await makeHarness();
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

pgDescribe("session routes (polling transport)", () => {
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
    const keep = await store.createAsync({ stage: "brainstorm" });
    const drop = await store.createAsync({ stage: "plan" });

    const missing = await call("DELETE", "/sessions/:id", { params: { id: "nope" } }, h.ctx);
    expect(missing.status).toBe(404);

    const deleted = await call("DELETE", "/sessions/:id", { params: { id: drop.id } }, h.ctx);
    expect(deleted.status).toBe(200);
    expect(await store.getAsync(drop.id)).toBeUndefined();
    expect(await store.getAsync(keep.id)).toBeDefined();
  });

  it("POST /sessions/:id/cancel interrupts an in-flight session", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    const created = (await store.updateAsync((await store.createAsync({ stage: "brainstorm" })).id, { status: "active" }))!;

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
    const created = (await store.updateAsync((await store.createAsync({ stage: "brainstorm" })).id, { status: "completed" }))!;

    const res = await call("POST", "/sessions/:id/cancel", { params: { id: created.id } }, h.ctx);

    expect(res.status).toBe(200);
    const session = (res.body as { session: { status: string; error: string | null } }).session;
    expect(session.status).toBe("completed");
    expect(session.error).toBeNull();
    expect((await store.getAsync(created.id))!.status).toBe("completed");
  });

  it("GET /sessions lists every session so a client can manage multiple concurrently", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    await store.createAsync({ stage: "brainstorm" });
    await store.createAsync({ stage: "plan" });

    const res = await call("GET", "/sessions", { params: {}, query: {} }, h.ctx);
    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions: Array<{ stage: string }> }).sessions;
    expect(sessions.map((s) => s.stage).sort()).toEqual(["brainstorm", "plan"]);
  });

  it("GET /sessions applies detached terminal fallbacks before status filtering", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    h.ctx.createInteractiveAiSession = vi.fn(async () => {
      throw new Error("detached factory failed");
    });
    const updateAsync = store.updateAsync.bind(store);
    vi.spyOn(store, "updateAsync").mockImplementation((sessionId, patch) => {
      if (patch.status === "error") return Promise.reject(new Error("terminal write failed"));
      return updateAsync(sessionId, patch);
    });

    const started = await call("POST", "/sessions", {
      params: {},
      body: { stage: "brainstorm", message: "go" },
    }, h.ctx);
    expect(started.status).toBe(201);
    const sessionId = (started.body as { session: { id: string } }).session.id;
    await vi.waitFor(() => expect(h.ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("terminal write failed"),
    ));
    expect((await store.getAsync(sessionId))?.status).toBe("launching");

    const all = await call("GET", "/sessions", { params: {}, query: {} }, h.ctx);
    const errors = await call("GET", "/sessions", { params: {}, query: { status: "error" } }, h.ctx);
    const launching = await call("GET", "/sessions", { params: {}, query: { status: "launching" } }, h.ctx);
    expect((all.body as { sessions: Array<{ id: string; status: string }> }).sessions).toContainEqual(
      expect.objectContaining({ id: sessionId, status: "error" }),
    );
    expect((errors.body as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id)).toContain(sessionId);
    expect((launching.body as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id)).not.toContain(sessionId);
  });

  it("GET /sessions enforces the task store's bound project over caller-supplied row ownership", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    const projectA = await store.createAsync({ stage: "brainstorm", projectId: "project-a" });
    await store.createAsync({ stage: "plan", projectId: "project-b" });
    await store.createAsync({ stage: "debug" });

    const res = await call("GET", "/sessions", { params: {}, query: { projectId: h.layer.projectId } }, h.ctx);

    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions: Array<{ id: string; projectId: string | null }> }).sessions;
    expect(sessions).toHaveLength(3);
    expect(sessions).toContainEqual(expect.objectContaining({ id: projectA.id, projectId: h.layer.projectId }));
    expect(sessions.every((session) => session.projectId === h.layer.projectId)).toBe(true);
  });

  it("GET /sessions keeps error, interrupted, awaiting_input, active, and completed rows independently manageable", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    const error = (await store.updateAsync((await store.createAsync({ stage: "debug" })).id, {
      status: "error",
      error: "Failed to parse agent response: AI returned no valid JSON.",
    }))!;
    const interrupted = (await store.updateAsync((await store.createAsync({ stage: "plan" })).id, {
      status: "interrupted",
      error: "Cancelled by user",
    }))!;
    const awaiting = (await store.updateAsync((await store.createAsync({ stage: "brainstorm" })).id, {
      status: "awaiting_input",
      currentQuestion: QUESTION,
    }))!;
    const active = (await store.updateAsync((await store.createAsync({ stage: "strategy", turnIntervalMs: 60_000 })).id, { status: "active" }))!;
    const completed = (await store.updateAsync((await store.createAsync({ stage: "work" })).id, { status: "completed" }))!;

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
    expect(await store.getAsync(error.id)).toBeUndefined();
    expect(await store.getAsync(completed.id)).toBeDefined();
  });

  it("GET /sessions recovers stale active rows that have no live route handle", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    const zombie = await store.createAsync({ stage: "strategy", turnIntervalMs: 1 });
    await store.updateAsync(zombie.id, {
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
    expect(await store.getAsync(zombie.id)).toMatchObject({
      status: "interrupted",
      error: "Session interrupted — progress preserved, resume to continue",
    });
  });

  it("GET /sessions/:id recovers a stale active row before returning it", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    const zombie = await store.createAsync({ stage: "strategy", turnIntervalMs: 1 });
    await store.updateAsync(zombie.id, {
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
    expect(await store.getAsync(zombie.id)).toMatchObject({
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

    let polled = await call("GET", "/sessions/:id", { params: { id: sessionId } }, h.ctx);
    await vi.waitFor(async () => {
      polled = await call("GET", "/sessions/:id", { params: { id: sessionId } }, h.ctx);
      expect((polled.body as { session: { status: string } }).session.status).toBe("awaiting_input");
    });
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
    const seeded = await getCeSessionStore(h.ctx).createAsync({ stage: "brainstorm" });
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
    const created = await store.createAsync({ stage: "brainstorm" });
    await store.appendHistoryAsync(created.id, { role: "user", text: "kick off", at: new Date().toISOString() });
    await store.appendHistoryAsync(created.id, {
      role: "agent",
      text: JSON.stringify({ question: QUESTION }),
      at: new Date().toISOString(),
    });
    await store.updateAsync(created.id, { status: "awaiting_input", currentQuestion: QUESTION });

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

    await vi.waitFor(async () => expect((await store.getAsync(created.id))?.status).toBe("completed"));
  });

  it("POST /sessions/:id/answer returns an honest no-factory error without corrupting an old awaiting_input session", async () => {
    const { getCeSessionStore } = await import("../session/session-store.js");
    const store = getCeSessionStore(h.ctx);
    const created = await store.createAsync({ stage: "brainstorm" });
    await store.appendHistoryAsync(created.id, { role: "user", text: "kick off", at: new Date().toISOString() });
    await store.appendHistoryAsync(created.id, {
      role: "agent",
      text: JSON.stringify({ question: QUESTION }),
      at: new Date().toISOString(),
    });
    await store.updateAsync(created.id, { status: "awaiting_input", currentQuestion: QUESTION });

    const res = await call(
      "POST",
      "/sessions/:id/answer",
      { params: { id: created.id }, body: { questionId: "q1", response: "a" } },
      h.ctx,
    );
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/cannot be continued in this process/i);
    expect((res.body as { error: string }).error).not.toMatch(/call resume\(\) first/i);
    const after = (await store.getAsync(created.id))!;
    expect(after.status).toBe("awaiting_input");
    expect(after.currentQuestion?.id).toBe("q1");
  });
});
