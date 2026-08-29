// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore, GlobalSettings, CustomProvider } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as performRequest } from "../../test-request.js";

const { mockInvalidateAllGlobalSettingsCaches } = vi.hoisted(() => ({
  mockInvalidateAllGlobalSettingsCaches: vi.fn(),
}));
vi.mock("../../project-store-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../../project-store-resolver.js")>("../../project-store-resolver.js");
  return {
    ...actual,
    invalidateAllGlobalSettingsCaches: mockInvalidateAllGlobalSettingsCaches,
  };
});

function createMockGlobalSettingsStore(settings: GlobalSettings) {
  return {
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(),
    getSettingsPath: vi.fn(),
    init: vi.fn(),
    invalidateCache: vi.fn(),
  };
}

function createMockStore(settings: GlobalSettings, onUpdate: (patch: Partial<GlobalSettings>) => void): TaskStore {
  const globalSettingsStore = createMockGlobalSettingsStore(settings);
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
    updateGlobalSettings: vi.fn(async (patch: Partial<GlobalSettings>) => {
      onUpdate(patch);
      Object.assign(settings, patch);
      return settings;
    }),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: settings, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: settings, project: {} }),
    getGlobalSettingsStore: vi.fn(() => globalSettingsStore),
    logEntry: vi.fn(),
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
    deleteTaskDocument: vi.fn(),
    updatePrInfo: vi.fn(),
    updateIssueInfo: vi.fn(),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    getFusionDir: vi.fn().mockReturnValue("/fake/root/.fusion"),
    getDatabase: vi.fn(),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    createWorkflowStep: vi.fn(),
    getWorkflowStep: vi.fn(),
    updateWorkflowStep: vi.fn(),
    deleteWorkflowStep: vi.fn(),
    getMissionStore: vi.fn(),
  } as unknown as TaskStore;
}

async function REQUEST(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const res = await performRequest(
    app,
    method,
    path,
    payload,
    body === undefined ? undefined : { "Content-Type": "application/json" },
  );
  return { status: res.status, body: res.body };
}

function createApp(settings: GlobalSettings, onUpdate: (patch: Partial<GlobalSettings>) => void = () => undefined) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(createMockStore(settings, onUpdate)));
  return app;
}

describe("custom provider routes", () => {
  let settings: GlobalSettings;

  beforeEach(() => {
    settings = {};
    mockInvalidateAllGlobalSettingsCaches.mockReset();
    vi.unstubAllGlobals();
  });

  it("GET /custom-providers returns empty array when none configured", async () => {
    const app = createApp(settings);
    const res = await REQUEST(app, "GET", "/api/custom-providers");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /custom-providers masks API keys", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "OpenAI Proxy",
        apiType: "openai-compatible",
        baseUrl: "https://proxy.example.com/v1",
        apiKey: "sk-test-secret-key-1234",
      },
      {
        id: "cp-2",
        name: "Anthropic Proxy",
        apiType: "anthropic-compatible",
        baseUrl: "https://anthropic.example.com",
        apiKey: "short",
      },
    ];

    const app = createApp(settings);
    const res = await REQUEST(app, "GET", "/api/custom-providers");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "cp-1",
        name: "OpenAI Proxy",
        apiType: "openai-compatible",
        baseUrl: "https://proxy.example.com/v1",
        apiKey: "sk-•••••1234",
      },
      {
        id: "cp-2",
        name: "Anthropic Proxy",
        apiType: "anthropic-compatible",
        baseUrl: "https://anthropic.example.com",
        apiKey: "••••••••",
      },
    ]);
  });

  it("POST /custom-providers creates provider with auto-generated id", async () => {
    const updates: Array<Partial<GlobalSettings>> = [];
    const app = createApp(settings, (patch) => updates.push(patch));

    const res = await REQUEST(app, "POST", "/api/custom-providers", {
      name: "My Provider",
      apiType: "openai-compatible",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-my-secret-5678",
      models: [{ id: "gpt-4.1", name: "GPT 4.1" }],
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(res.body.apiKey).toBe("sk-•••••5678");
    expect(updates).toHaveLength(1);
    expect(mockInvalidateAllGlobalSettingsCaches).toHaveBeenCalledTimes(1);

    const persisted = updates[0].customProviders as CustomProvider[];
    expect(persisted[0]?.apiKey).toBe("sk-my-secret-5678");
  });

  it("POST /custom-providers rejects missing name", async () => {
    const app = createApp(settings);
    const res = await REQUEST(app, "POST", "/api/custom-providers", {
      apiType: "openai-compatible",
      baseUrl: "https://example.com",
    });

    expect(res.status).toBe(400);
  });

  it("POST /custom-providers accepts openai-responses apiType", async () => {
    const app = createApp(settings);
    const createRes = await REQUEST(app, "POST", "/api/custom-providers", {
      name: "Responses Provider",
      apiType: "openai-responses",
      baseUrl: "https://responses.example.com/v1",
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.apiType).toBe("openai-responses");

    const listRes = await REQUEST(app, "GET", "/api/custom-providers");
    expect(listRes.status).toBe(200);
    expect(listRes.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Responses Provider",
        apiType: "openai-responses",
      }),
    ]));
  });

  it("POST /custom-providers rejects invalid apiType", async () => {
    const app = createApp(settings);
    const res = await REQUEST(app, "POST", "/api/custom-providers", {
      name: "Invalid",
      apiType: "bad-type",
      baseUrl: "https://example.com",
    });

    expect(res.status).toBe(400);
  });

  it("POST /custom-providers rejects invalid baseUrl", async () => {
    const app = createApp(settings);
    const res = await REQUEST(app, "POST", "/api/custom-providers", {
      name: "Invalid URL",
      apiType: "openai-compatible",
      baseUrl: "not-a-url",
    });

    expect(res.status).toBe(400);
  });

  it("POST /custom-providers rejects non-http/https baseUrl", async () => {
    const app = createApp(settings);
    const res = await REQUEST(app, "POST", "/api/custom-providers", {
      name: "FTP URL",
      apiType: "openai-compatible",
      baseUrl: "ftp://example.com",
    });

    expect(res.status).toBe(400);
  });

  it("PUT /custom-providers/:id updates an existing provider", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "Original",
        apiType: "openai-compatible",
        baseUrl: "https://original.example.com",
      },
    ];

    const app = createApp(settings);
    const res = await REQUEST(app, "PUT", "/api/custom-providers/cp-1", {
      name: "Updated",
      apiType: "openai-responses",
      apiKey: "sk-updated-9999",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "cp-1",
      name: "Updated",
      apiType: "openai-responses",
      baseUrl: "https://original.example.com",
      apiKey: "sk-•••••9999",
    });
  });

  it("PUT /custom-providers/:id preserves stored key when a masked key is echoed back", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "Original",
        apiType: "openai-compatible",
        baseUrl: "https://original.example.com",
        apiKey: "sk-real-secret-1234",
      },
    ];

    const updates: Array<Partial<GlobalSettings>> = [];
    const app = createApp(settings, (patch) => updates.push(patch));
    const res = await REQUEST(app, "PUT", "/api/custom-providers/cp-1", {
      name: "Updated",
      // The UI sends back the masked key when the field is left untouched.
      apiKey: "sk-•••••1234",
    });

    expect(res.status).toBe(200);
    const persisted = updates[0].customProviders as CustomProvider[];
    // The original key must survive — never overwritten with the mask.
    expect(persisted[0]?.apiKey).toBe("sk-real-secret-1234");
    // And no mask character ever reaches the stored credential.
    expect(persisted[0]?.apiKey).not.toContain("•");
  });

  it("PUT /custom-providers/:id updates the key when a real key is provided", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "Original",
        apiType: "openai-compatible",
        baseUrl: "https://original.example.com",
        apiKey: "sk-old-key-0000",
      },
    ];

    const updates: Array<Partial<GlobalSettings>> = [];
    const app = createApp(settings, (patch) => updates.push(patch));
    const res = await REQUEST(app, "PUT", "/api/custom-providers/cp-1", {
      apiKey: "sk-brand-new-9999",
    });

    expect(res.status).toBe(200);
    const persisted = updates[0].customProviders as CustomProvider[];
    expect(persisted[0]?.apiKey).toBe("sk-brand-new-9999");
  });

  it("POST /custom-providers rejects a masked API key", async () => {
    const app = createApp(settings);
    const res = await REQUEST(app, "POST", "/api/custom-providers", {
      name: "My Provider",
      apiType: "openai-compatible",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-•••••5678",
    });

    expect(res.status).toBe(400);
  });

  it("PUT /custom-providers/:id returns 404 for non-existent id", async () => {
    const app = createApp(settings);
    const res = await REQUEST(app, "PUT", "/api/custom-providers/missing", {
      name: "Updated",
    });

    expect(res.status).toBe(404);
  });

  it("DELETE /custom-providers/:id removes a provider", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "Delete Me",
        apiType: "openai-compatible",
        baseUrl: "https://example.com",
      },
    ];

    const app = createApp(settings);
    const res = await REQUEST(app, "DELETE", "/api/custom-providers/cp-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(settings.customProviders).toEqual([]);
    expect(mockInvalidateAllGlobalSettingsCaches).toHaveBeenCalledTimes(1);
  });

  it("DELETE /custom-providers/:id returns 404 for non-existent id", async () => {
    const app = createApp(settings);
    const res = await REQUEST(app, "DELETE", "/api/custom-providers/missing");

    expect(res.status).toBe(404);
  });

  it("POST /custom-providers/:id/refresh-models uses stored keys and updates only the selected provider", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "OpenAI Proxy",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-stored-secret",
        models: [{ id: "stale-model", name: "Stale model" }],
      },
      {
        id: "cp-2",
        name: "Sibling",
        apiType: "openai-compatible",
        baseUrl: "https://sibling.example.com/v1",
        apiKey: "sk-sibling-secret",
        models: [{ id: "sibling-model", name: "Sibling model" }],
      },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "fresh-model", name: "Fresh model" },
          { id: "fresh-model", name: "Duplicate model" },
          { id: "embedding-model", name: "Embedding model" },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const updates: Array<Partial<GlobalSettings>> = [];
    const app = createApp(settings, (patch) => updates.push(patch));

    const res = await REQUEST(app, "POST", "/api/custom-providers/cp-1/refresh-models");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-stored-secret" }),
      }),
    );
    expect(res.body).toEqual({
      provider: expect.objectContaining({
        id: "cp-1",
        apiKey: "sk-•••••cret",
        models: [{ id: "fresh-model", name: "Fresh model" }],
      }),
      modelsRefreshed: 1,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].customProviders).toEqual([
      expect.objectContaining({ id: "cp-1", models: [{ id: "fresh-model", name: "Fresh model" }] }),
      expect.objectContaining({ id: "cp-2", models: [{ id: "sibling-model", name: "Sibling model" }] }),
    ]);
    expect(mockInvalidateAllGlobalSettingsCaches).toHaveBeenCalledTimes(1);
  });

  it("POST /custom-providers/:id/refresh-models allows intentional local provider endpoints", async () => {
    settings.customProviders = [
      {
        id: "cp-local",
        name: "Local LM Studio",
        apiType: "openai-compatible",
        baseUrl: "http://localhost:1234/v1",
        apiKey: "local-secret",
        models: [{ id: "stale-local", name: "Stale local" }],
      },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "local-model", name: "Local model" }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp(settings);

    const res = await REQUEST(app, "POST", "/api/custom-providers/cp-local/refresh-models");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:1234/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer local-secret" }),
      }),
    );
    expect(settings.customProviders?.[0]?.models).toEqual([{ id: "local-model", name: "Local model" }]);
  });

  it("POST /custom-providers/:id/refresh-models preserves concurrent provider changes made during probing", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "OpenAI Proxy",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-stored-secret",
        models: [{ id: "stale-model", name: "Stale model" }],
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => {
      settings.customProviders = [
        {
          id: "cp-1",
          name: "Renamed While Refreshing",
          apiType: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-stored-secret",
          supportsDeveloperRole: true,
          models: [{ id: "edited-model", name: "Edited model" }],
        },
        {
          id: "cp-2",
          name: "Added While Refreshing",
          apiType: "anthropic-compatible",
          baseUrl: "https://anthropic.example.com/v1",
          apiKey: "sk-added-secret",
          models: [{ id: "added-model", name: "Added model" }],
        },
      ];
      return {
        ok: true,
        json: async () => ({ data: [{ id: "fresh-model", name: "Fresh model" }] }),
      };
    }));
    const updates: Array<Partial<GlobalSettings>> = [];
    const app = createApp(settings, (patch) => updates.push(patch));

    const res = await REQUEST(app, "POST", "/api/custom-providers/cp-1/refresh-models");

    expect(res.status).toBe(200);
    expect(res.body.provider).toEqual(expect.objectContaining({
      id: "cp-1",
      name: "Renamed While Refreshing",
      supportsDeveloperRole: true,
      models: [{ id: "fresh-model", name: "Fresh model" }],
    }));
    expect(updates).toHaveLength(1);
    expect(updates[0].customProviders).toEqual([
      expect.objectContaining({
        id: "cp-1",
        name: "Renamed While Refreshing",
        supportsDeveloperRole: true,
        models: [{ id: "fresh-model", name: "Fresh model" }],
      }),
      expect.objectContaining({
        id: "cp-2",
        name: "Added While Refreshing",
        models: [{ id: "added-model", name: "Added model" }],
      }),
    ]);
  });

  it("POST /custom-providers/:id/refresh-models aborts when connection fields change during probing", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "OpenAI Proxy",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-stored-secret",
        models: [{ id: "stale-model", name: "Stale model" }],
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => {
      settings.customProviders = [
        {
          id: "cp-1",
          name: "OpenAI Proxy",
          apiType: "openai-compatible",
          baseUrl: "https://new-api.example.com/v1",
          apiKey: "sk-new-secret",
          models: [{ id: "edited-model", name: "Edited model" }],
        },
      ];
      return {
        ok: true,
        json: async () => ({ data: [{ id: "old-endpoint-model", name: "Old endpoint model" }] }),
      };
    }));
    const updates: Array<Partial<GlobalSettings>> = [];
    const app = createApp(settings, (patch) => updates.push(patch));

    const res = await REQUEST(app, "POST", "/api/custom-providers/cp-1/refresh-models");

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("connection changed during model refresh");
    expect(updates).toHaveLength(0);
    expect(settings.customProviders?.[0]).toEqual(expect.objectContaining({
      baseUrl: "https://new-api.example.com/v1",
      apiKey: "sk-new-secret",
      models: [{ id: "edited-model", name: "Edited model" }],
    }));
  });

  it("POST /custom-providers/:id/refresh-models preserves models when probing fails", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "OpenAI Proxy",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-stored-secret",
        models: [{ id: "stale-model", name: "Stale model" }],
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "bad key",
    })));
    const updates: Array<Partial<GlobalSettings>> = [];
    const app = createApp(settings, (patch) => updates.push(patch));

    const res = await REQUEST(app, "POST", "/api/custom-providers/cp-1/refresh-models");

    expect(res.status).toBe(401);
    expect(updates).toHaveLength(0);
    expect(settings.customProviders?.[0]?.models).toEqual([{ id: "stale-model", name: "Stale model" }]);
  });

  it("POST /custom-providers/:id/refresh-models preserves models when only non-chat models are returned", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "OpenAI Proxy",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "stale-model", name: "Stale model" }],
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "text-embedding-3-large" }] }),
    })));
    const updates: Array<Partial<GlobalSettings>> = [];
    const app = createApp(settings, (patch) => updates.push(patch));

    const res = await REQUEST(app, "POST", "/api/custom-providers/cp-1/refresh-models");

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("No chat models found");
    expect(updates).toHaveLength(0);
    expect(settings.customProviders?.[0]?.models).toEqual([{ id: "stale-model", name: "Stale model" }]);
  });

  it("POST /custom-providers/:id/refresh-models returns 404 for unknown providers", async () => {
    settings.customProviders = [];
    const app = createApp(settings);
    const res = await REQUEST(app, "POST", "/api/custom-providers/missing/refresh-models");

    expect(res.status).toBe(404);
  });
});
