// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { CustomProvider, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request } from "../../test-request.js";

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
    CentralCore: vi.fn().mockImplementation(() => ({
      init: mockCentralInit,
      close: mockCentralClose,
      listProjects: mockCentralListProjects,
      reconcileProjectStatuses: mockCentralReconcileProjectStatuses,
    })),
  };
});

vi.mock("@fusion/engine", () => ({
  createFnAgent: vi.fn(async () => ({ session: { state: { messages: [] }, prompt: vi.fn(), dispose: vi.fn() } })),
  createResolvedAgentSession: vi.fn(async () => ({
    session: { state: { messages: [] }, prompt: vi.fn(), dispose: vi.fn() },
    provider: "test",
    model: "test",
  })),
  promptWithFallback: vi.fn(),
}));

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
