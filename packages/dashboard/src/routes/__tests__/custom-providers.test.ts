// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { CustomProvider, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request } from "../../test-request.js";
import { probeProviderModels } from "../register-custom-provider-routes.js";

const mockCentralListProjects = vi.fn().mockResolvedValue([]);
const mockCentralInit = vi.fn().mockResolvedValue(undefined);
const mockCentralClose = vi.fn().mockResolvedValue(undefined);
const mockCentralReconcileProjectStatuses = vi.fn().mockResolvedValue(undefined);

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    isGhAvailable: vi.fn(),
    isGhAuthenticated: vi.fn(),
    isQmdAvailable: vi.fn().mockResolvedValue(false),
    CentralCore: vi.fn().mockImplementation(function () { return {
      init: mockCentralInit,
      close: mockCentralClose,
      listProjects: mockCentralListProjects,
      reconcileProjectStatuses: mockCentralReconcileProjectStatuses,
    }; }),
  };
});

/*
FNXC:DashboardRouteTests 2026-08-15-05:10:
Route mounting imports model-registry refresh constants from @fusion/engine, so wholesale inline
engine mocks go stale whenever the barrel grows. Use the canonical createEngineMock helper
(fallback vi.fn() proxy) instead of hand-listing every export.
*/
vi.mock("@fusion/engine", async () => {
  const { createEngineMock } = await import("../../test/mockCoreEngine.js");
  return createEngineMock({
    listCliAdapterDescriptors: () => [],
    createFnAgent: vi.fn(async () => ({ session: { state: { messages: [] }, prompt: vi.fn(), dispose: vi.fn() } })),
    createResolvedAgentSession: vi.fn(async () => ({
      session: { state: { messages: [] }, prompt: vi.fn(), dispose: vi.fn() },
      provider: "test",
      model: "test",
    })),
    promptWithFallback: vi.fn(),
  });
});

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    searchTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    updateGlobalSettings: vi.fn(),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    getAgentLogCount: vi.fn().mockResolvedValue(0),
    getAgentLogsByTimeRange: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    addTaskComment: vi.fn(),
    updateTaskComment: vi.fn(),
    deleteTaskComment: vi.fn(),
    getTaskDocuments: vi.fn().mockResolvedValue([]),
    getTaskDocument: vi.fn().mockResolvedValue(null),
    getTaskDocumentRevisions: vi.fn().mockResolvedValue([]),
    getAllDocuments: vi.fn().mockResolvedValue([]),
    upsertTaskDocument: vi.fn(),
    deleteTaskDocument: vi.fn().mockResolvedValue(undefined),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    updateIssueInfo: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    createWorkflowStep: vi.fn(),
    getWorkflowStep: vi.fn(),
    updateWorkflowStep: vi.fn(),
    deleteWorkflowStep: vi.fn(),
    getMissionStore: vi.fn().mockReturnValue({
      listMissions: vi.fn().mockReturnValue([]),
      createMission: vi.fn(),
      getMissionWithHierarchy: vi.fn(),
      updateMission: vi.fn(),
      getMission: vi.fn(),
      deleteMission: vi.fn(),
      listMilestonesByMission: vi.fn().mockReturnValue([]),
      createMilestone: vi.fn(),
      updateMilestone: vi.fn(),
      getMilestone: vi.fn(),
      deleteMilestone: vi.fn(),
      listTasksByMilestone: vi.fn().mockReturnValue([]),
      createMissionTask: vi.fn(),
      updateMissionTask: vi.fn(),
      getMissionTask: vi.fn(),
      deleteMissionTask: vi.fn(),
    }),
    ...overrides,
  } as unknown as TaskStore;
}

function createCustomProviderStore(initialCustomProviders: CustomProvider[] = []) {
  let customProviders = [...initialCustomProviders];
  const globalSettingsStore = {
    getSettings: vi.fn().mockImplementation(async () => ({ customProviders })),
    updateSettings: vi.fn().mockImplementation(async (updates: { customProviders?: CustomProvider[] }) => {
      customProviders = updates.customProviders ?? customProviders;
      return { customProviders };
    }),
  };

  const store = createMockStore({
    getGlobalSettingsStore: vi.fn().mockReturnValue(globalSettingsStore),
    updateGlobalSettings: vi.fn().mockImplementation(async (updates: { customProviders?: CustomProvider[] }) => {
      customProviders = updates.customProviders ?? customProviders;
      return { customProviders };
    }),
  });

  return { store, globalSettingsStore };
}

function setupApp(store?: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store ?? createCustomProviderStore().store));
  return app;
}

async function doRequest(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
) {
  return request(
    app,
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    body === undefined ? undefined : { "Content-Type": "application/json" },
  );
}

describe("custom providers API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/custom-providers returns empty array when none configured", async () => {
    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "GET", "/api/custom-providers");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /api/custom-providers returns existing providers with masked api keys", async () => {
    const app = setupApp(
      createCustomProviderStore([
        {
          id: "cp-1",
          name: "Provider One",
          apiType: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-1234567890",
          models: [{ id: "model-1", name: "Model 1" }],
        },
        {
          id: "cp-2",
          name: "Provider Two",
          apiType: "anthropic-compatible",
          baseUrl: "https://anthropic.example.com",
          apiKey: "short",
        },
      ]).store,
    );

    const res = await doRequest(app, "GET", "/api/custom-providers");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: "cp-1",
        name: "Provider One",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "model-1", name: "Model 1" }],
        apiKey: "sk-•••••7890",
      }),
      expect.objectContaining({
        id: "cp-2",
        apiKey: "••••••••",
      }),
    ]);
  });

  it("POST /api/custom-providers creates provider and persists settings", async () => {
    const { store } = createCustomProviderStore();
    const app = setupApp(store);
    const res = await doRequest(app, "POST", "/api/custom-providers", {
      name: "My Provider",
      apiType: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: "My Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
      }),
    );
    expect(vi.mocked(store.updateGlobalSettings)).toHaveBeenCalledWith({
      customProviders: [expect.objectContaining({ name: "My Provider" })],
    });
  });

  it("POST /api/custom-providers rejects missing name", async () => {
    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers", {
      apiType: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
    });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("name is required");
  });

  it("POST /api/custom-providers rejects invalid apiType", async () => {
    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers", {
      name: "Bad",
      apiType: "invalid",
      baseUrl: "https://api.example.com/v1",
    });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("apiType must be");
  });

  it("POST /api/custom-providers rejects invalid baseUrl format", async () => {
    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers", {
      name: "Bad URL",
      apiType: "openai-compatible",
      baseUrl: "not-a-url",
    });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("baseUrl must be a valid URL");
  });

  it("POST /api/custom-providers rejects non-http/https baseUrl", async () => {
    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers", {
      name: "Bad URL",
      apiType: "openai-compatible",
      baseUrl: "ftp://example.com",
    });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("baseUrl must use http or https");
  });

  it("PUT /api/custom-providers/:id updates existing provider", async () => {
    const app = setupApp(
      createCustomProviderStore([
        {
          id: "cp-1",
          name: "Provider One",
          apiType: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
        },
      ]).store,
    );

    const res = await doRequest(app, "PUT", "/api/custom-providers/cp-1", {
      name: "Provider One Updated",
      baseUrl: "https://api.updated.example.com/v1",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: "cp-1",
        name: "Provider One Updated",
        baseUrl: "https://api.updated.example.com/v1",
      }),
    );
  });

  it("PUT /api/custom-providers/:id returns 404 for unknown id", async () => {
    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "PUT", "/api/custom-providers/unknown", {
      name: "Updated",
    });

    expect(res.status).toBe(404);
    expect(String(res.body.error)).toContain("not found");
  });

  it("PUT /api/custom-providers/:id validates baseUrl", async () => {
    const app = setupApp(
      createCustomProviderStore([
        {
          id: "cp-1",
          name: "Provider One",
          apiType: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
        },
      ]).store,
    );

    const res = await doRequest(app, "PUT", "/api/custom-providers/cp-1", {
      baseUrl: "ftp://example.com",
    });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("baseUrl must use http or https");
  });

  it("DELETE /api/custom-providers/:id removes provider", async () => {
    const app = setupApp(
      createCustomProviderStore([
        {
          id: "cp-1",
          name: "Provider One",
          apiType: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
        },
      ]).store,
    );

    const del = await doRequest(app, "DELETE", "/api/custom-providers/cp-1");
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ success: true });

    const getAfter = await doRequest(app, "GET", "/api/custom-providers");
    expect(getAfter.status).toBe(200);
    expect(getAfter.body).toEqual([]);
  });

  it("DELETE /api/custom-providers/:id returns 404 for unknown id", async () => {
    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "DELETE", "/api/custom-providers/unknown");

    expect(res.status).toBe(404);
    expect(String(res.body.error)).toContain("not found");
  });
});

describe("POST /api/custom-providers/probe-models", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns OpenAI-compatible models", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-4o", object: "model", owned_by: "system" },
          { id: "gpt-4", object: "model", owned_by: "system" },
        ],
      }),
    });

    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers/probe-models", {
      baseUrl: "https://api.openai.com/v1",
      apiType: "openai-compatible",
      apiKey: "sk-test",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      count: 2,
      models: [
        { id: "gpt-4o", name: "gpt-4o", reasoning: false },
        { id: "gpt-4", name: "gpt-4", reasoning: false },
      ],
    });
  });

  it("routes openai-responses through the OpenAI-compatible probe branch", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-5", object: "model", owned_by: "system" },
        ],
      }),
    });

    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers/probe-models", {
      baseUrl: "https://api.openai.com/v1",
      apiType: "openai-responses",
      apiKey: "sk-test",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      count: 1,
      models: [
        { id: "gpt-5", name: "gpt-5", reasoning: false },
      ],
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
      }),
    );
  });

  it("returns Anthropic-compatible models", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "claude-sonnet-4-20250514", object: "model", display_name: "Claude Sonnet 4" },
          { id: "claude-haiku-4-5-20251001", object: "model", display_name: "Claude Haiku 4.5" },
          { id: "claude-opus-4-20250514", object: "model", display_name: "Claude Opus 4" },
        ],
      }),
    });

    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers/probe-models", {
      baseUrl: "https://api.anthropic.com",
      apiType: "anthropic-compatible",
      apiKey: "sk-ant-test",
    });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.models[0]).toEqual({
      id: "claude-sonnet-4-20250514",
      name: "Claude Sonnet 4",
      reasoning: false, // standard sonnet without thinking capability
    });
    expect(res.body.models[2]).toEqual({
      id: "claude-opus-4-20250514",
      name: "Claude Opus 4",
      reasoning: true, // opus detected as reasoning
    });
  });

  it("returns Google Generative AI models", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          {
            name: "models/gemini-2.0-flash",
            baseModelId: "gemini-2.0-flash",
            displayName: "Gemini 2.0 Flash",
            inputTokenLimit: 1048576,
            outputTokenLimit: 8192,
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/text-embedding-004",
            baseModelId: "text-embedding-004",
            displayName: "Text Embedding",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
      }),
    });

    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers/probe-models", {
      baseUrl: "https://generativelanguage.googleapis.com",
      apiType: "google-generative-ai",
      apiKey: "AIza-test",
    });

    expect(res.status).toBe(200);
    // Embedding model should be filtered out
    expect(res.body.count).toBe(1);
    expect(res.body.models[0]).toEqual({
      id: "gemini-2.0-flash",
      name: "Gemini 2.0 Flash",
      reasoning: false,
      contextWindow: 1048576,
      maxTokens: 8192,
    });
  });

  it("excludes embedding models from OpenAI-compatible response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-4o", object: "model", modalities: { input: ["text"], output: ["text"] } },
          { id: "text-embedding-3", object: "model", modalities: { input: ["text"], output: ["embedding"] } },
          { id: "whisper-large", object: "model", modalities: { input: ["audio"], output: ["text"] } },
        ],
      }),
    });

    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers/probe-models", {
      baseUrl: "https://api.example.com/v1",
      apiType: "openai-compatible",
    });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1); // embedding + audio-input both excluded
    expect(res.body.models[0].id).toBe("gpt-4o");
  });

  it("excludes models without text input from OpenAI-compatible response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-4o", object: "model", modalities: { input: ["text", "image"], output: ["text"] } },
          { id: "scribe-v2", object: "model", modalities: { input: ["audio"], output: ["text"] } },
          { id: "eleven-v3", object: "model", modalities: { input: ["text"], output: ["audio"] } },
        ],
      }),
    });

    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers/probe-models", {
      baseUrl: "https://api.example.com/v1",
      apiType: "openai-compatible",
    });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1); // only gpt-4o has text input + text output
    expect(res.body.models[0].id).toBe("gpt-4o");
  });

  it("rejects invalid apiType for probe", async () => {
    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers/probe-models", {
      baseUrl: "https://api.example.com",
      apiType: "invalid",
    });

    expect(res.status).toBe(400);
  });

  it("detects reasoning models from ID", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "o1-preview", object: "model" },
          { id: "o3-mini", object: "model" },
          { id: "gpt-4o", object: "model" },
        ],
      }),
    });

    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers/probe-models", {
      baseUrl: "https://api.openai.com/v1",
      apiType: "openai-compatible",
    });

    expect(res.body.models[0].reasoning).toBe(true);  // o1-preview
    expect(res.body.models[1].reasoning).toBe(true);  // o3-mini
    expect(res.body.models[2].reasoning).toBe(false); // gpt-4o
  });

  it("returns 400 for missing baseUrl", async () => {
    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers/probe-models", {
      apiType: "openai-compatible",
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid URL", async () => {
    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers/probe-models", {
      baseUrl: "not-a-url",
      apiType: "openai-compatible",
    });

    expect(res.status).toBe(400);
  });

  it("keeps SSRF protection for untrusted Detect Models probe input", async () => {
    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers/probe-models", {
      baseUrl: "http://localhost:1234/v1",
      apiType: "openai-compatible",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("loopback or private address");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns error when provider returns non-200", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Invalid API key",
    });

    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers/probe-models", {
      baseUrl: "https://api.openai.com/v1",
      apiType: "openai-compatible",
      apiKey: "sk-invalid",
    });

    expect(res.status).toBe(401);
  });

  it("handles { models: [...] } response format", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { id: "llama-3.1-8b", name: "Llama 3.1 8B" },
        ],
      }),
    });

    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers/probe-models", {
      baseUrl: "https://api.example.com",
      apiType: "openai-compatible",
    });

    expect(res.status).toBe(200);
    expect(res.body.models[0]).toEqual({
      id: "llama-3.1-8b",
      name: "Llama 3.1 8B",
      reasoning: false,
    });
  });

  it("truncates large model lists to 100", async () => {
    const manyModels = Array.from({ length: 150 }, (_, i) => ({
      id: `model-${i}`,
      object: "model",
    }));
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: manyModels }),
    });

    const app = setupApp(createCustomProviderStore().store);
    const res = await doRequest(app, "POST", "/api/custom-providers/probe-models", {
      baseUrl: "https://api.example.com",
      apiType: "openai-compatible",
    });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(100);
    expect(res.body.models.length).toBe(100);
  });
});

/*
FNXC:LocalProviderWindowDetection 2026-08-22-02:05:
RUFU-138: body-level window extraction is exercised against the exported probeProviderModels
directly (fetch stubbed) so these scenarios stay independent of the express harness and can
assert the exact outbound fetch budget — while every model resolves a window from the /v1/models
body (directly or via one-level LoRA parent inheritance) the main probe must remain the only
fetch, which is also the precondition that keeps the trusted-refresh enrichment gate silent.
*/
describe("probeProviderModels body-level window extraction", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("extracts vLLM max_model_len, LoRA parent inheritance, OpenRouter limit, and LM Studio max_context_size", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "llama-70b", object: "model", max_model_len: 131072 },
          { id: "llama-70b-lora", object: "model", parent: "llama-70b" },
          { id: "gpt-4o", object: "model", limit: { context: 128000, output: 16384 } },
          { id: "qwen2.5-7b", object: "model", max_context_size: 32768 },
        ],
      }),
    });

    const models = await probeProviderModels("http://localhost:11434/v1", undefined, "openai-compatible", { allowPrivateAddress: true });

    expect(models.map((m) => m.contextWindow)).toEqual([131072, 131072, 128000, 32768]);
    expect(models[0].maxTokens).toBeUndefined();
    expect(models[1].maxTokens).toBeUndefined();
    expect(models[2].maxTokens).toBe(16384);
    expect(models[3].maxTokens).toBeUndefined();
    // Every model ended with a window (directly or via parent), so the trusted-refresh
    // enrichment gate stays quiet: exactly one fetch (the main probe only).
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/v1/models",
      expect.any(Object),
    );
  });

  it("prefers OpenRouter limit.context over vLLM max_model_len", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "hybrid-model", object: "model", limit: { context: 64000 }, max_model_len: 131072 },
        ],
      }),
    });

    const models = await probeProviderModels("http://localhost:8000/v1", undefined, "openai-compatible", { allowPrivateAddress: true });
    expect(models[0].contextWindow).toBe(64000);
  });

  it("keeps contextWindow undefined for zero, string, and NaN window values", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "zero-model", object: "model", max_model_len: 0 },
          { id: "string-model", object: "model", max_model_len: "8192" },
          { id: "nan-model", object: "model", context_length: Number.NaN },
        ],
      }),
    });

    const models = await probeProviderModels("http://localhost:11434/v1", undefined, "openai-compatible", { allowPrivateAddress: true });
    expect(models.map((m) => m.contextWindow)).toEqual([undefined, undefined, undefined]);
  });
});

/*
FNXC:LocalProviderWindowDetection 2026-08-22-02:05:
RUFU-138: trusted-refresh enrichment coverage. These scenarios exercise the same-origin
native-API enrichment (Ollama /api/tags + /api/show, LM Studio /api/v1/models) against the
exported probeProviderModels with allowPrivateAddress: true — the trusted-refresh contract the
startup sweep and the saved-provider Refresh Models action run — and assert the bounded fetch
budget (main probe + at most tags + native + 25 show calls) and the best-effort no-throw
contract on hostile local endpoints.
*/
describe("probeProviderModels trusted-refresh enrichment", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("Ollama modern: tags details.context_length plus /api/show fallback with Bearer headers", async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === "http://localhost:11434/v1/models") {
        return { ok: true, json: async () => ({ data: [{ id: "llama3:latest", owned_by: "library" }, { id: "mistral:7b" }] }) };
      }
      if (input === "http://localhost:11434/api/tags") {
        return { ok: true, json: async () => ({ models: [{ name: "llama3:latest", details: { context_length: 8192 } }, { name: "mistral:7b", details: { format: "gguf" } }] }) };
      }
      if (input === "http://localhost:11434/api/show") {
        return { ok: true, json: async () => ({ model_info: { "mistral.context_length": 32768, "mistral.embedding_length": 4096 } }) };
      }
      throw new Error(`unexpected URL: ${input}`);
    });

    const models = await probeProviderModels("http://localhost:11434/v1", "local-secret", "openai-compatible", { allowPrivateAddress: true });

    expect(models.map((m) => [m.id, m.contextWindow])).toEqual([
      ["llama3:latest", 8192],
      ["mistral:7b", 32768],
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer local-secret" }) }),
    );
    const showCalls = fetchMock.mock.calls.filter((c) => c[0] === "http://localhost:11434/api/show");
    expect(showCalls).toHaveLength(1);
    expect(showCalls[0][1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "mistral:7b" }),
        headers: expect.objectContaining({ Authorization: "Bearer local-secret" }),
      }),
    );
  });

  it("Ollama legacy: tags without context_length fall through to per-model /api/show arch-prefixed keys", async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === "http://localhost:11434/v1/models") {
        return { ok: true, json: async () => ({ data: [{ id: "llama-3.1-8b" }, { id: "qwen3-8b" }] }) };
      }
      if (input === "http://localhost:11434/api/tags") {
        return { ok: true, json: async () => ({ models: [{ name: "llama-3.1-8b", details: { format: "gguf" } }, { name: "qwen3-8b", details: { format: "gguf" } }] }) };
      }
      if (input === "http://localhost:11434/api/show") {
        const name = JSON.parse(String(init?.body)).name;
        return {
          ok: true,
          json: async () => ({ model_info: name === "llama-3.1-8b" ? { "llama.context_length": 8192 } : { "qwen3.context_length": 32768 } }),
        };
      }
      throw new Error(`unexpected URL: ${input}`);
    });

    const models = await probeProviderModels("http://localhost:11434/v1", undefined, "openai-compatible", { allowPrivateAddress: true });

    expect(models.map((m) => [m.id, m.contextWindow])).toEqual([
      ["llama-3.1-8b", 8192],
      ["qwen3-8b", 32768],
    ]);
  });

  it("caps /api/show probes at 25 for a 30-model install", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `model-${i}`);
    fetchMock.mockImplementation(async (input: string) => {
      if (input === "http://localhost:11434/v1/models") {
        return { ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) };
      }
      if (input === "http://localhost:11434/api/tags") {
        return { ok: true, json: async () => ({ models: ids.map((id) => ({ name: id, details: { format: "gguf" } })) }) };
      }
      if (input === "http://localhost:11434/api/show") {
        return { ok: true, json: async () => ({ model_info: {} }) };
      }
      throw new Error(`unexpected URL: ${input}`);
    });

    const models = await probeProviderModels("http://localhost:11434/v1", undefined, "openai-compatible", { allowPrivateAddress: true });

    expect(models).toHaveLength(30);
    const showCalls = fetchMock.mock.calls.filter((c) => c[0] === "http://localhost:11434/api/show");
    expect(showCalls).toHaveLength(25);
  });

  it("LM Studio native fallback: /api/v1/models key matching, no window leak to a non-chat id", async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === "http://localhost:1234/v1/models") {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: "qwen2.5-7b-instruct", object: "model" },
              { id: "nomic-embed@q8_0", object: "model", modalities: { input: ["text"], output: ["embedding"] } },
            ],
          }),
        };
      }
      if (input === "http://localhost:1234/api/tags") {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (input === "http://localhost:1234/api/v1/models") {
        return {
          ok: true,
          json: async () => ({
            models: [
              { key: "qwen2.5-7b-instruct", type: "llm", max_context_length: 32768 },
              { key: "nomic-embed", type: "embedding", max_context_length: 2048 },
            ],
          }),
        };
      }
      throw new Error(`unexpected URL: ${input}`);
    });

    const models = await probeProviderModels("http://localhost:1234/v1", undefined, "openai-compatible", { allowPrivateAddress: true });

    // The embedding entry is filtered by isNonChatModel, so it never reaches the result —
    // no window may leak to a non-chat id and the 2048 embedding window must not appear.
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("qwen2.5-7b-instruct");
    expect(models[0].contextWindow).toBe(32768);
    expect(models.some((m) => m.id.includes("embed") || m.contextWindow === 2048)).toBe(false);
  });

  it("LM Studio: variant-suffixed chat id matches the native key via the @-prefix rule", async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === "http://localhost:1234/v1/models") {
        return { ok: true, json: async () => ({ data: [{ id: "qwen2.5-7b-instruct@q8_0", object: "model" }] }) };
      }
      if (input === "http://localhost:1234/api/tags") {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (input === "http://localhost:1234/api/v1/models") {
        return { ok: true, json: async () => ({ models: [{ key: "qwen2.5-7b-instruct", type: "llm", max_context_length: 32768 }] }) };
      }
      throw new Error(`unexpected URL: ${input}`);
    });

    const models = await probeProviderModels("http://localhost:1234/v1", undefined, "openai-compatible", { allowPrivateAddress: true });

    expect(models[0].id).toBe("qwen2.5-7b-instruct@q8_0");
    expect(models[0].contextWindow).toBe(32768);
  });

  it("skips enrichment entirely when every model already has a window (exactly one fetch)", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m1", max_model_len: 8192 }] }) });

    const models = await probeProviderModels("http://localhost:11434/v1", undefined, "openai-compatible", { allowPrivateAddress: true });

    expect(models[0].contextWindow).toBe(8192);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips enrichment on public hosts even with allowPrivateAddress (exactly one fetch)", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m1" }] }) });

    const models = await probeProviderModels("https://api.example.com/v1", undefined, "openai-compatible", { allowPrivateAddress: true });

    expect(models[0].contextWindow).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips enrichment for anthropic-compatible apiType (exactly one fetch, no /api/tags)", async () => {
    fetchMock.mockImplementation(async (input: string) => {
      expect(input).toBe("http://localhost:1234/v1/models");
      return { ok: true, json: async () => ({ data: [{ id: "claude-3-opus", display_name: "Claude 3 Opus" }] }) };
    });

    const models = await probeProviderModels("http://localhost:1234", undefined, "anthropic-compatible", { allowPrivateAddress: true });

    expect(models[0].id).toBe("claude-3-opus");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves with windowless models when tags and native endpoints both 404 (plain local server)", async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === "http://localhost:8080/v1/models") {
        return { ok: true, json: async () => ({ data: [{ id: "model-a" }] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const models = await probeProviderModels("http://localhost:8080/v1", undefined, "openai-compatible", { allowPrivateAddress: true });

    expect(models[0].id).toBe("model-a");
    expect(models[0].contextWindow).toBeUndefined();
  });

  it("does not throw when tags json() rejects (malformed body)", async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === "http://localhost:11434/v1/models") {
        return { ok: true, json: async () => ({ data: [{ id: "model-a" }] }) };
      }
      if (input === "http://localhost:11434/api/tags") {
        return { ok: true, json: async () => { throw new Error("malformed body"); } };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const models = await probeProviderModels("http://localhost:11434/v1", undefined, "openai-compatible", { allowPrivateAddress: true });

    expect(models[0].contextWindow).toBeUndefined();
  });

  it("leaves a model windowless when /api/show returns 500 for it", async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === "http://localhost:11434/v1/models") {
        return { ok: true, json: async () => ({ data: [{ id: "a" }, { id: "b" }] }) };
      }
      if (input === "http://localhost:11434/api/tags") {
        return { ok: true, json: async () => ({ models: [{ name: "a", details: { context_length: 4096 } }] }) };
      }
      if (input === "http://localhost:11434/api/show") {
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
      }
      throw new Error(`unexpected URL: ${input}`);
    });

    const models = await probeProviderModels("http://localhost:11434/v1", undefined, "openai-compatible", { allowPrivateAddress: true });

    expect(models.map((m) => [m.id, m.contextWindow])).toEqual([
      ["a", 4096],
      ["b", undefined],
    ]);
  });

  it("ignores non-numeric (string) and zero model_info context_length values", async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === "http://localhost:11434/v1/models") {
        return { ok: true, json: async () => ({ data: [{ id: "a" }, { id: "b" }] }) };
      }
      if (input === "http://localhost:11434/api/tags") {
        return { ok: true, json: async () => ({ models: [] }) };
      }
      if (input === "http://localhost:11434/api/show") {
        const name = JSON.parse(String(init?.body)).name;
        return { ok: true, json: async () => ({ model_info: name === "a" ? { "llama.context_length": "8192" } : { "qwen3.context_length": 0 } }) };
      }
      throw new Error(`unexpected URL: ${input}`);
    });

    const models = await probeProviderModels("http://localhost:11434/v1", undefined, "openai-compatible", { allowPrivateAddress: true });

    expect(models.map((m) => m.contextWindow)).toEqual([undefined, undefined]);
  });
});
