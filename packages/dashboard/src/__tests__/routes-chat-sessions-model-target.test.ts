// @vitest-environment node

import express from "express";
import multer from "multer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStore } from "@fusion/core";
import { request } from "../test-request.js";
import { registerChatRoutes } from "../routes/register-chat-routes.js";

function postJson(app: express.Express, body: unknown) {
  return request(app, "POST", "/api/chat/sessions", JSON.stringify(body), {
    "content-type": "application/json",
  });
}

/** The client-only sentinel from `app/hooks/useChat.ts` marking a model-target chat.
 *  It is intentionally never persisted as an agent row. */
const FN_AGENT_ID = "__fn_agent__";

function buildApp(getAgent: (id: string) => unknown) {
  const createSession = vi.fn(async (input: Record<string, unknown>) => ({ id: "session-1", ...input }));
  vi.spyOn(AgentStore.prototype, "init").mockResolvedValue(undefined);
  vi.spyOn(AgentStore.prototype, "getAgent").mockImplementation(async (id) => getAgent(id) as never);

  const scopedStore = {
    getFusionDir: () => "/route-project/.fusion",
    getAsyncLayer: () => undefined,
    getSettings: async () => ({
      defaultProvider: "global-provider",
      defaultModelId: "global-model",
      defaultThinkingLevelOverride: "high",
    }),
  };
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerChatRoutes({
    router,
    store: scopedStore,
    options: { chatStore: { createSession } },
    getProjectContext: async () => ({ store: scopedStore, projectId: "project-1", engine: undefined }),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never, {
    parseLastEventId: () => undefined,
    replayBufferedSSE: () => false,
    validateOptionalModelField: () => undefined,
    upload: multer(),
  });
  app.use("/api", router);
  // The route rethrows ApiError; without a boundary the error paths would hang
  // rather than assert a status.
  app.use((err: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? "unknown" });
  });
  return { app, createSession };
}

/*
FNXC:ChatSessionCreate 2026-08-11-09:38:
Symptom Verification for the model-target chat regression.

Original symptom: every "new chat" against a MODEL (rather than an agent) failed with the toast
"Failed to create chat session". FN-8869 hoisted the agent-existence check out of its `else` branch so it
ran unconditionally, and model-target chats send the agent-less sentinel `__fn_agent__` -> HTTP 404
"Agent __fn_agent__ not found".

Exact reproduction: POST /api/chat/sessions {agentId:"__fn_agent__", modelProvider, modelId}.
Assertion it is gone: that POST returns 201 and persists the client model pair.

Surface enumeration -- the invariant is "a missing agent row only fails creation when the agent is the
model SOURCE", so all of these are covered below rather than the single reported id:
  - the literal `__fn_agent__` sentinel (the reported repro)
  - any other unknown agent id carrying a complete model pair (the route must not hardcode the sentinel)
  - the negative case: unknown agent id with NO model pair still 404s (the check is narrowed, not deleted)
  - a real agent's inheritance path is untouched (covered by routes-chat-sessions-project-model.test.ts)
  - agent-less sessions inherit no thinking level, since there is no role to inherit from
*/
describe("POST /api/chat/sessions model-target (agent-less) creation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a session for the __fn_agent__ sentinel when a model pair is supplied", async () => {
    const { app, createSession } = buildApp(() => null);

    const res = await postJson(app, {
      agentId: FN_AGENT_ID,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-8",
    });

    expect(res.status).toBe(201);
    expect(res.body.session).toMatchObject({
      agentId: FN_AGENT_ID,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-8",
    });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("does not hardcode the sentinel: any unresolvable agent id with a model pair still creates", async () => {
    const { app } = buildApp(() => null);

    const res = await postJson(app, {
      agentId: "some-other-agentless-marker",
      modelProvider: "openai-codex",
      modelId: "gpt-5.6",
    });

    expect(res.status).toBe(201);
    expect(res.body.session).toMatchObject({
      modelProvider: "openai-codex",
      modelId: "gpt-5.6",
    });
  });

  it("agent-less sessions inherit no thinking level", async () => {
    const { app } = buildApp(() => null);

    const res = await postJson(app, {
      agentId: FN_AGENT_ID,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-8",
    });

    expect(res.status).toBe(201);
    expect(res.body.session.thinkingLevel).toBeUndefined();
  });

  it("honours an explicit client thinking level on an agent-less session", async () => {
    const { app } = buildApp(() => null);

    const res = await postJson(app, {
      agentId: FN_AGENT_ID,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-8",
      thinkingLevel: "high",
    });

    expect(res.status).toBe(201);
    expect(res.body.session).toMatchObject({ thinkingLevel: "high" });
  });

  it("still 404s an unknown agent when the agent is the model source", async () => {
    const { app, createSession } = buildApp(() => null);

    const res = await postJson(app, { agentId: "genuinely-missing-agent" });

    expect(res.status).toBe(404);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("still rejects a half-supplied model pair", async () => {
    const { app } = buildApp(() => null);

    const res = await postJson(app, { agentId: FN_AGENT_ID, modelProvider: "anthropic" });

    expect(res.status).toBe(400);
  });
});
