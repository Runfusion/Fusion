// @vitest-environment node
/**
 * FNXC:TaskSearch 2026-09-17-09:41:
 * FN-477 exercises the ACTUALLY REGISTERED `POST /api/ai/search-tasks` handler, not the service in
 * isolation. The ordering guarantees only exist at this layer: validation must reject before the
 * budget is touched, the budget must be consumed before a session can exist, and every service error
 * code must reach the browser as a distinguishable status without provider prose.
 */
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerAiTextAssistantRoutes } from "../register-ai-text-assistant-routes.js";
import { AI_TASK_SEARCH_ERROR_CODES, AI_TASK_SEARCH_MAX_QUERY_LENGTH } from "../../shared/task-search.js";

const search = vi.hoisted(() => {
  class AiTaskSearchError extends Error {
    code: string;
    constructor(code: string, message?: string) {
      super(message ?? code);
      this.name = "AiTaskSearchError";
      this.code = code;
    }
  }
  return {
    AiTaskSearchError,
    checkAiTaskSearchRateLimit: vi.fn(() => true),
    getAiTaskSearchRateLimitResetTime: vi.fn(() => new Date("2026-09-17T10:00:00.000Z")),
    searchTasksWithAi: vi.fn(async () => [] as unknown[]),
    __resetAiTaskSearchStateForTests: vi.fn(),
  };
});
vi.mock("../../ai-task-search.js", () => search);

const refine = vi.hoisted(() => {
  class ValidationError extends Error {}
  class InvalidTypeError extends Error {}
  return { checkRateLimit: vi.fn(() => true), validateRefineRequest: vi.fn(), validateGoalDraftRequest: vi.fn(), refineText: vi.fn(), draftGoalDescription: vi.fn(), getRateLimitResetTime: vi.fn(), ValidationError, InvalidTypeError };
});
vi.mock("../../ai-refine.js", () => refine);

function createStore() {
  return {
    getRootDir: () => "/root/project-a",
    getSettings: vi.fn().mockResolvedValue({}),
    searchTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(),
  };
}

function app(overrides: { engine?: unknown } = {}) {
  const store = createStore();
  const router = express.Router();
  registerAiTextAssistantRoutes({
    router,
    getProjectContext: vi.fn().mockResolvedValue({ store, engine: overrides.engine }),
  } as never);
  const server = express();
  server.use(express.json());
  server.use("/api", router);
  server.use((err: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(err.statusCode ?? 500).json({ error: err.message }));
  return { server, store };
}

const headers = { "Content-Type": "application/json" };
const post = (server: express.Express, body: unknown) =>
  request(server, "POST", "/api/ai/search-tasks", JSON.stringify(body), headers);

beforeEach(() => {
  vi.clearAllMocks();
  search.checkAiTaskSearchRateLimit.mockReturnValue(true);
  search.searchTasksWithAi.mockResolvedValue([]);
});

describe("POST /api/ai/search-tasks", () => {
  it("returns the echoed query with the verified task rows", async () => {
    const rows = [{ id: "FN-2", title: "Newer" }, { id: "FN-1", title: "Older" }];
    search.searchTasksWithAi.mockResolvedValue(rows);
    const { server } = app();

    const response = await post(server, { query: "  collapse  " });

    expect(response.status).toBe(200);
    // The echoed query is the TRIMMED phrase the selection belongs to, so a late response can be
    // fenced by the browser against the field's current value.
    expect(response.body).toEqual({ query: "collapse", tasks: rows });
    expect(search.searchTasksWithAi).toHaveBeenCalledWith(expect.objectContaining({ query: "collapse" }));
  });

  it.each([
    ["missing body field", {}],
    ["non-string query", { query: 42 }],
    ["blank query", { query: "   " }],
    ["over-long query", { query: "x".repeat(AI_TASK_SEARCH_MAX_QUERY_LENGTH + 1) }],
  ])("rejects %s with 400 before spending budget or creating a session", async (_label, body) => {
    const { server } = app();
    const response = await post(server, body);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe(AI_TASK_SEARCH_ERROR_CODES.validation);
    expect(search.checkAiTaskSearchRateLimit).not.toHaveBeenCalled();
    expect(search.searchTasksWithAi).not.toHaveBeenCalled();
  });

  it("returns 429 without creating a session when the dedicated budget is exhausted", async () => {
    search.checkAiTaskSearchRateLimit.mockReturnValue(false);
    const { server } = app();

    const response = await post(server, { query: "collapse" });

    expect(response.status).toBe(429);
    expect(response.body.error).toBe(AI_TASK_SEARCH_ERROR_CODES.rateLimited);
    expect(search.searchTasksWithAi).not.toHaveBeenCalled();
  });

  it("keys the budget on the project root so two projects do not share one quota", async () => {
    const { server } = app();
    await post(server, { query: "collapse" });
    expect(search.checkAiTaskSearchRateLimit).toHaveBeenCalledWith("/root/project-a", expect.any(String));
  });

  it("does not consume the shared refine/draft budget", async () => {
    const { server } = app();
    await post(server, { query: "collapse" });
    expect(refine.checkRateLimit).not.toHaveBeenCalled();
  });

  it.each([
    [AI_TASK_SEARCH_ERROR_CODES.rateLimited, 429],
    [AI_TASK_SEARCH_ERROR_CODES.timeout, 504],
    [AI_TASK_SEARCH_ERROR_CODES.invalidModelResponse, 502],
    [AI_TASK_SEARCH_ERROR_CODES.unavailable, 503],
  ])("maps the %s service code to HTTP %i", async (code, status) => {
    search.searchTasksWithAi.mockRejectedValue(new search.AiTaskSearchError(code, "provider said: sk-secret leaked"));
    const { server } = app();

    const response = await post(server, { query: "collapse" });

    expect(response.status).toBe(status);
    // The stable code reaches the client; the provider's prose does not.
    expect(response.body.error).toBe(code);
    expect(JSON.stringify(response.body)).not.toContain("sk-secret");
  });

  it("forwards the project engine plugin runner so CLI-runtime models resolve", async () => {
    const pluginRunner = { getRuntimeById: vi.fn() };
    const { server } = app({ engine: { getPluginRunner: () => pluginRunner } });

    await post(server, { query: "collapse" });

    expect(search.searchTasksWithAi).toHaveBeenCalledWith(expect.objectContaining({ pluginRunner }));
  });

  it("omits the plugin runner entirely when the project has no engine", async () => {
    const { server } = app();
    await post(server, { query: "collapse" });
    expect(search.searchTasksWithAi.mock.calls[0][0]).not.toHaveProperty("pluginRunner");
  });

  it("passes an abort signal that the service can use to stop a disconnected generation", async () => {
    const { server } = app();
    await post(server, { query: "collapse" });
    const passed = search.searchTasksWithAi.mock.calls[0][0] as { signal?: AbortSignal };
    expect(passed.signal).toBeInstanceOf(AbortSignal);
  });

  it("never mutates a task, workflow, or setting while searching", async () => {
    const { server, store } = app();
    await post(server, { query: "collapse" });
    // The route's only store interaction is reading the project root for the budget key.
    expect(store.getSettings).not.toHaveBeenCalled();
    expect(store.getTask).not.toHaveBeenCalled();
  });
});
