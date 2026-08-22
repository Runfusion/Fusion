// @vitest-environment node

import express from "express";
import multer from "multer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "../test-request.js";
import { registerChatRoutes } from "../routes/register-chat-routes.js";

const PROJECT_ID = "project-a";
const TASK_ID = "FN-033";
const AGENT_ID = `task-planner:${TASK_ID}`;

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "chat-fn-033",
    agentId: AGENT_ID,
    title: "FN-033 task chat",
    status: "active",
    projectId: PROJECT_ID,
    modelProvider: "anthropic",
    modelId: "claude-planner",
    thinkingLevel: "low",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:01:00.000Z",
    pinnedAt: null,
    cliSessionFile: null,
    cliExecutorAdapterId: null,
    inFlightGeneration: null,
    ...overrides,
  };
}

function buildApp(initialSessions: Array<Record<string, unknown>> = []) {
  const sessions = [...initialSessions];
  const lifecycleLocks = new Map<string, Promise<void>>();
  const withPlanningLifecycleLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prior = lifecycleLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    lifecycleLocks.set(id, current);
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (lifecycleLocks.get(id) === current) lifecycleLocks.delete(id);
    }
  };
  const updateSession = vi.fn(async (id: string, updates: Record<string, unknown>) => {
    const session = sessions.find((candidate) => candidate.id === id);
    if (!session) return undefined;
    Object.assign(session, updates);
    return session;
  });
  const createSession = vi.fn(async (input: Record<string, unknown>) => {
    const session = makeSession({
      id: `created-${sessions.length + 1}`,
      ...input,
    });
    sessions.push(session);
    return session;
  });
  const findLatestActiveSessionForTarget = vi.fn(async (input: { agentId: string; projectId?: string; modelProvider?: string; modelId?: string }) => {
    return sessions
      .filter((session) => session.status === "active" && session.agentId === input.agentId)
      .filter((session) => !input.projectId || session.projectId === input.projectId)
      .filter((session) => !input.modelProvider || (session.modelProvider === input.modelProvider && session.modelId === input.modelId))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0];
  });
  const chatStore = {
    createSession,
    updateSession,
    findLatestActiveSessionForTarget,
    getLastMessageForSessions: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { id }]))),
  };
  const scopedStore = {
    getFusionDir: () => "/route-project/.fusion",
    getAsyncLayer: () => undefined,
    getSettings: async () => ({ defaultProvider: "global-provider", defaultModelId: "global-model" }),
    getTask: async (id: string) => id === TASK_ID ? { id, column: "todo" } : null,
    withPlanningLifecycleLock,
  };

  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerChatRoutes({
    router,
    store: scopedStore,
    options: { chatStore },
    getProjectContext: async (req: express.Request) => ({
      store: scopedStore,
      projectId: typeof req.query.projectId === "string" ? req.query.projectId : PROJECT_ID,
      engine: undefined,
    }),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never, {
    parseLastEventId: () => undefined,
    replayBufferedSSE: () => false,
    validateOptionalModelField: (value: unknown) => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "string") throw new Error("model field must be a string");
      return value.trim() || undefined;
    },
    upload: multer(),
  });
  app.use("/api", router);
  app.use((err: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? "unknown" });
  });
  return { app, sessions, chatStore, updateSession, createSession };
}

describe("task Chat session routes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("looks up a prior task transcript without matching the current model", async () => {
    const prior = makeSession();
    const { app, chatStore } = buildApp([prior]);

    const response = await request(
      app,
      "GET",
      `/api/chat/sessions?lookup=resume&agentId=${encodeURIComponent(AGENT_ID)}&projectId=${PROJECT_ID}&modelProvider=openai&modelId=gpt-direct`,
    );

    expect(response.status).toBe(200);
    expect(response.body.sessions).toHaveLength(1);
    expect(response.body.sessions[0].id).toBe(prior.id);
    expect(chatStore.findLatestActiveSessionForTarget).toHaveBeenCalledWith({ agentId: AGENT_ID, projectId: PROJECT_ID });
    expect(chatStore.getLastMessageForSessions).toHaveBeenCalledTimes(1);
  });

  it("updates the same task session target on an explicit send without creating a duplicate", async () => {
    const prior = makeSession();
    const { app, updateSession, createSession } = buildApp([prior]);

    const response = await request(app, "POST", `/api/chat/task-planner/${TASK_ID}/session?projectId=${PROJECT_ID}`, JSON.stringify({
      modelProvider: "openai",
      modelId: "gpt-direct",
      thinkingLevel: "high",
    }), { "content-type": "application/json" });

    expect(response.status).toBe(200);
    expect(response.body.session.id).toBe(prior.id);
    expect(response.body.session).toMatchObject({ modelProvider: "openai", modelId: "gpt-direct", thinkingLevel: "high" });
    expect(updateSession).toHaveBeenCalledWith(prior.id, { modelProvider: "openai", modelId: "gpt-direct", thinkingLevel: "high" });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("creates one scoped task session with the Direct model and thinking pair", async () => {
    const { app, createSession } = buildApp([]);

    const response = await request(app, "POST", `/api/chat/task-planner/${TASK_ID}/session?projectId=${PROJECT_ID}`, JSON.stringify({
      modelProvider: "openai",
      modelId: "gpt-direct",
      thinkingLevel: "medium",
    }), { "content-type": "application/json" });

    expect(response.status).toBe(201);
    expect(response.body.session).toMatchObject({
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      modelProvider: "openai",
      modelId: "gpt-direct",
      thinkingLevel: "medium",
    });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent first sends into one task transcript", async () => {
    const { app, sessions, createSession } = buildApp([]);
    const body = JSON.stringify({ modelProvider: "openai", modelId: "gpt-direct", thinkingLevel: "high" });

    const responses = await Promise.all([
      request(app, "POST", `/api/chat/task-planner/${TASK_ID}/session?projectId=${PROJECT_ID}`, body, { "content-type": "application/json" }),
      request(app, "POST", `/api/chat/task-planner/${TASK_ID}/session?projectId=${PROJECT_ID}`, body, { "content-type": "application/json" }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(responses[0].body.session.id).toBe(responses[1].body.session.id);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveLength(1);
  });

  it("rejects malformed targets before persistence", async () => {
    const { app, updateSession, createSession } = buildApp([makeSession()]);

    const halfPair = await request(app, "POST", `/api/chat/task-planner/${TASK_ID}/session?projectId=${PROJECT_ID}`, JSON.stringify({ modelProvider: "openai" }), { "content-type": "application/json" });
    const badThinking = await request(app, "POST", `/api/chat/task-planner/${TASK_ID}/session?projectId=${PROJECT_ID}`, JSON.stringify({ modelProvider: "openai", modelId: "gpt-direct", thinkingLevel: "extreme" }), { "content-type": "application/json" });

    expect(halfPair.status).toBe(400);
    expect(badThinking.status).toBe(400);
    expect(updateSession).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("does not cross project task scope", async () => {
    const { app, updateSession, createSession } = buildApp([makeSession({ projectId: "project-b" })]);

    const lookup = await request(app, "GET", `/api/chat/sessions?lookup=resume&agentId=${encodeURIComponent(AGENT_ID)}&projectId=${PROJECT_ID}`);
    const send = await request(app, "POST", `/api/chat/task-planner/${TASK_ID}/session?projectId=${PROJECT_ID}`, JSON.stringify({ modelProvider: "openai", modelId: "gpt-direct" }), { "content-type": "application/json" });

    expect(lookup.status).toBe(200);
    expect(lookup.body.sessions).toEqual([]);
    expect(send.status).toBe(201);
    expect(updateSession).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});
