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

  it("PUT /custom-providers/:id clears the stored model list on an explicit empty models array", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "Original",
        apiType: "openai-compatible",
        baseUrl: "https://original.example.com",
        models: [{ id: "old-model", name: "Old model" }],
      },
    ];

    const app = createApp(settings);
    // FNXC:CustomProviderModelWindows 2026-08-21-00:06: RUFU-145 PR #3493 review (Greptile
    // P1): the partial merge must distinguish an omitted `models` key (keep stored list)
    // from an explicit empty array (persist the operator's clear). This is the server-side
    // half of the invariant the editor's explicit models: [] save depends on.
    const res = await REQUEST(app, "PUT", "/api/custom-providers/cp-1", {
      name: "Original",
      apiType: "openai-compatible",
      models: [],
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "cp-1", models: [] });
    expect(settings.customProviders?.[0]?.models).toEqual([]);
  });

  it("PUT /custom-providers/:id keeps the stored model list when models is omitted", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "Original",
        apiType: "openai-compatible",
        baseUrl: "https://original.example.com",
        models: [{ id: "old-model", name: "Old model" }],
      },
    ];

    const app = createApp(settings);
    const res = await REQUEST(app, "PUT", "/api/custom-providers/cp-1", {
      name: "Renamed",
      apiType: "openai-compatible",
    });

    expect(res.status).toBe(200);
    expect(settings.customProviders?.[0]?.models).toEqual([{ id: "old-model", name: "Old model" }]);
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
        /*
         * FNXC:CustomProviderModelWindows 2026-08-19-14:18:
         * RUFU-123: the preservation fixture carries manually persisted per-model
         * windows — a failed probe must keep the full previous list INCLUDING those
         * values, not drop them.
         */
        models: [{ id: "stale-model", name: "Stale model", contextWindow: 32768, maxTokens: 4096 }],
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
    expect(settings.customProviders?.[0]?.models).toEqual([
      { id: "stale-model", name: "Stale model", contextWindow: 32768, maxTokens: 4096 },
    ]);
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

/*
FNXC:CustomProviderModelWindows 2026-08-19-14:18:
RUFU-123: per-model contextWindow/maxTokens on the custom-provider CRUD + refresh
paths. Symptom-verification assertion 1 (settings round-trip): POST/PUT with
contextWindow 32768 / maxTokens 4096 persist and GET returns them unchanged; invalid
values are rejected 400 with the field path named. The refresh-models id-merge keeps
manual windows when the probe reports none (Anthropic-compatible) and lets probe
windows win when present (OpenAI-compatible limit fields).
*/
describe("RUFU-123: per-model contextWindow/maxTokens round-trip", () => {
  let settings: GlobalSettings;

  beforeEach(() => {
    settings = {};
    vi.unstubAllGlobals();
  });

  it("POST + GET + PUT round-trip preserves per-model windows unchanged", async () => {
    const app = createApp(settings);
    const posted = await REQUEST(app, "POST", "/api/custom-providers", {
      name: "RUFU-123 Provider",
      apiType: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      models: [
        { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 32768, maxTokens: 4096 },
        { id: "legacy-model", name: "Legacy Model" },
      ],
    });
    expect(posted.status).toBe(201);
    expect(posted.body.models).toEqual([
      { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 32768, maxTokens: 4096 },
      { id: "legacy-model", name: "Legacy Model" },
    ]);
    const providerId = posted.body.id as string;

    const fetched = await REQUEST(app, "GET", "/api/custom-providers");
    expect(fetched.status).toBe(200);
    const fetchedModel = fetched.body.find((p: any) => p.id === providerId)?.models?.[0];
    expect(fetchedModel).toEqual({ id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 32768, maxTokens: 4096 });

    const updated = await REQUEST(app, "PUT", `/api/custom-providers/${providerId}`, {
      models: [
        { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 65536, maxTokens: 8192 },
        { id: "legacy-model", name: "Legacy Model" },
      ],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.models).toEqual([
      { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 65536, maxTokens: 8192 },
      { id: "legacy-model", name: "Legacy Model" },
    ]);
    // The model entry without window fields stays key-free — no explicit undefined.
    expect(settings.customProviders?.[0]?.models?.[1]).toEqual({ id: "legacy-model", name: "Legacy Model" });
  });

  it.each([
    { field: "contextWindow", values: [0, -1, "abc"] },
    { field: "maxTokens", values: [0, -1, "abc"] },
  ])("POST rejects invalid models[0].%s as 400", async ({ field, values }) => {
    const app = createApp(settings);
    for (const value of values) {
      const res = await REQUEST(app, "POST", "/api/custom-providers", {
        name: "RUFU-123 Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "m", name: "M", [field]: value }],
      });
      expect(res.status, `value=${String(value)}`).toBe(400);
      expect(res.body.error).toContain(`models[0].${field}`);
    }
    expect(settings.customProviders).toBeUndefined();
  });

  it("PUT rejects invalid models[0].contextWindow as 400", async () => {
    settings.customProviders = [
      { id: "cp-1", name: "P", apiType: "openai-compatible", baseUrl: "https://api.example.com/v1" },
    ];
    const app = createApp(settings);
    const res = await REQUEST(app, "PUT", "/api/custom-providers/cp-1", {
      models: [{ id: "m", name: "M", contextWindow: Number.NaN }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("models[0].contextWindow");
    expect(settings.customProviders?.[0]?.models).toBeUndefined();
  });

  it("refresh-models overwrites prior windows when the OpenAI-compatible probe reports limit fields", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "OpenAI Proxy",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-stored-secret",
        models: [
          { id: "fresh-model", name: "Fresh model", contextWindow: 100000, maxTokens: 8192 },
          { id: "probe-only-model", name: "Probe only" },
        ],
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "fresh-model", name: "Fresh model", limit: { context: 32768, output: 4096 } },
          { id: "probe-only-model", name: "Probe only", limit: { context: 8192 } },
        ],
      }),
    })));
    const app = createApp(settings);

    const res = await REQUEST(app, "POST", "/api/custom-providers/cp-1/refresh-models");

    expect(res.status).toBe(200);
    expect(settings.customProviders?.[0]?.models).toEqual([
      { id: "fresh-model", name: "Fresh model", contextWindow: 32768, maxTokens: 4096 },
      // Probe reported only the window for this model — prior (absent) maxTokens stays absent.
      { id: "probe-only-model", name: "Probe only", contextWindow: 8192 },
    ]);
  });

  it("refresh-models on an Anthropic-compatible provider preserves manual windows the probe never reports", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "Anthropic Proxy",
        apiType: "anthropic-compatible",
        baseUrl: "https://anthropic.example.com/v1",
        apiKey: "sk-stored-secret",
        models: [
          { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", contextWindow: 200000, maxTokens: 8192 },
          { id: "legacy-model", name: "Legacy model" },
        ],
      },
    ];
    // Anthropic's models list carries no window data — the probe returns id/display_name only.
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "claude-sonnet-4-20250514", display_name: "Claude Sonnet 4" },
          { id: "claude-opus-4-20250514", display_name: "Claude Opus 4" },
        ],
      }),
    })));
    const app = createApp(settings);

    const res = await REQUEST(app, "POST", "/api/custom-providers/cp-1/refresh-models");

    expect(res.status).toBe(200);
    expect(settings.customProviders?.[0]?.models).toEqual([
      // The manual 200000/8192 windows survive the refresh via the id-merge.
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", contextWindow: 200000, maxTokens: 8192 },
      // Newly discovered model: no prior windows to merge.
      { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
    ]);
  });

  /*
  FNXC:CustomProviderModelWindows 2026-08-20-22:24: RUFU-145 PR #3493 review regression:
  the refresh merged the probe against the PRE-PROBE persisted windows, so a concurrent
  model-limit edit during the probe window was overwritten on write-back. The
  source-of-truth map must be built from the re-read record. Production getSettings()
  returns a fresh object per read, so this test clones per read — the shared settings
  alias of the surrounding harness would hide the stale-map bug.
  */
  it("refresh-models preserves a concurrent model-limit edit made during probing", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "P",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-stored-secret",
        models: [{ id: "m1", name: "M1", contextWindow: 32768, maxTokens: 4096 }],
      },
    ];
    const store = createMockStore(settings, () => undefined);
    store.getGlobalSettingsStore = vi.fn(() => ({
      getSettings: vi.fn(async () => structuredClone(settings)),
      updateSettings: vi.fn(),
      getSettingsPath: vi.fn(),
      init: vi.fn(),
      invalidateCache: vi.fn(),
    }));
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    // The probe omits limit objects (common for OpenAI-compatible endpoints). During
    // the probe window a concurrent PUT raises m1's contextWindow to 65536.
    vi.stubGlobal("fetch", vi.fn(async () => {
      settings.customProviders![0]!.models = [{ id: "m1", name: "M1", contextWindow: 65536, maxTokens: 4096 }];
      return {
        ok: true,
        json: async () => ({ data: [{ id: "m1", name: "M1" }] }),
      };
    }));

    const res = await REQUEST(app, "POST", "/api/custom-providers/cp-1/refresh-models");
    expect(res.status).toBe(200);
    // The concurrent edit must survive the refresh write-back (stale-map regression).
    expect(settings.customProviders?.[0]?.models).toEqual([
      { id: "m1", name: "M1", contextWindow: 65536, maxTokens: 4096 },
    ]);
  });

  /*
  FNXC:CustomProviderModelWindows 2026-08-20-22:27: RUFU-145 PR #3493 review invariant:
  the output reservation must fit inside the context window on every persistence
  surface (POST, PUT, refresh). A pair where maxTokens >= contextWindow makes the
  chat-lane compaction hard limit (contextWindow - max(16384, maxTokens)) non-positive
  — the review fixture persisted contextWindow 8192 with no maxTokens, the engine
  defaulted maxTokens to 16384, and the documented threshold became -8192.
  */
  it("POST rejects a model whose maxTokens cannot fit its contextWindow (incompatible pair invariant)", async () => {
    const app = createApp(settings);
    const res = await REQUEST(app, "POST", "/api/custom-providers", {
      name: "RUFU-123 Provider",
      apiType: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "probe-only-model", name: "Probe only", contextWindow: 8192, maxTokens: 16384 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("models[0].maxTokens");
    expect(res.body.error).toContain("models[0].contextWindow");
    expect(settings.customProviders).toBeUndefined();
  });

  it("PUT rejects a model whose maxTokens cannot fit its contextWindow (incompatible pair invariant)", async () => {
    const app = createApp(settings);
    const posted = await REQUEST(app, "POST", "/api/custom-providers", {
      name: "RUFU-123 Provider",
      apiType: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "probe-only-model", name: "Probe only", contextWindow: 8192 }],
    });
    expect(posted.status).toBe(201);
    const providerId = posted.body.id as string;
    const res = await REQUEST(app, "PUT", `/api/custom-providers/${providerId}`, {
      models: [{ id: "probe-only-model", name: "Probe only", contextWindow: 8192, maxTokens: 16384 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("models[0].maxTokens");
    // The rejected update is not persisted.
    expect(settings.customProviders?.[0]?.models).toEqual([{ id: "probe-only-model", name: "Probe only", contextWindow: 8192 }]);
  });

  it("refresh-models drops a probed output limit that cannot fit the probed context window (incompatible pair invariant)", async () => {
    const settings: GlobalSettings = {
      customProviders: [
        {
          id: "cp-1",
          name: "Small window",
          apiType: "openai-compatible",
          baseUrl: "https://api.small.example.com/v1",
          apiKey: "sk-test-1",
        },
      ],
    };
    const app = createApp(settings);
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { method?: string }) => {
      if (init?.method === "GET") {
        return {
          ok: true,
          json: async () => ({ data: [{ id: "m1", name: "M1", limit: { context: 8192, output: 16384 } }] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    const res = await REQUEST(app, "POST", "/api/custom-providers/cp-1/refresh-models");
    expect(res.status).toBe(200);
    // The inconsistent probed output limit is dropped; the window persists alone so
    // the engine default + safe small-window guard threshold apply downstream.
    expect(settings.customProviders?.[0]?.models).toEqual([{ id: "m1", name: "M1", contextWindow: 8192 }]);
  });

  /*
  FNXC:CustomProviderThinkingFormat 2026-08-21-05:47:
  RUFU-143: the dashboard persists the per-model thinking flags verbatim (additive to the
  RUFU-123 window fields). Invalid thinkingFormat values and non-boolean reasoning are rejected
  400 with the exact field path named; the flags round-trip through sanitizeProvider into the
  create/list responses; refresh-models carries a prior thinkingFormat over when set and a prior
  reasoning opt-out (false) across re-probing — never pre-filling flags from the probe heuristic,
  which would silently change the wire behavior of a model that was working.
  */
  it("POST /custom-providers accepts and persists per-model thinking flags (RUFU-143)", async () => {
    const updates: Array<Partial<GlobalSettings>> = [];
    const app = createApp(settings, (patch) => updates.push(patch));

    const res = await REQUEST(app, "POST", "/api/custom-providers", {
      name: "Qwen LiteLLM",
      apiType: "openai-compatible",
      baseUrl: "https://litellm.example.com/v1",
      apiKey: "sk-qwen-1234",
      models: [
        { id: "qwen3", name: "Qwen3", thinkingFormat: "qwen-chat-template", reasoning: false },
        { id: "other", name: "Other" },
      ],
    });

    expect(res.status).toBe(201);
    // Flags round-trip through the create response (sanitizeProvider keeps model entries verbatim).
    expect(res.body.models).toEqual([
      { id: "qwen3", name: "Qwen3", thinkingFormat: "qwen-chat-template", reasoning: false },
      { id: "other", name: "Other" },
    ]);
    const persisted = updates[0].customProviders as CustomProvider[];
    expect(persisted[0]?.models).toEqual([
      { id: "qwen3", name: "Qwen3", thinkingFormat: "qwen-chat-template", reasoning: false },
      { id: "other", name: "Other" },
    ]);

    // GET round-trip: the flag appears on the listed (sanitized) provider.
    const listRes = await REQUEST(app, "GET", "/api/custom-providers");
    expect(listRes.status).toBe(200);
    expect(listRes.body[0]?.models?.[0]).toEqual({ id: "qwen3", name: "Qwen3", thinkingFormat: "qwen-chat-template", reasoning: false });
  });

  it("POST /custom-providers rejects an invalid thinkingFormat with the field path (RUFU-143)", async () => {
    const app = createApp(settings);

    const res = await REQUEST(app, "POST", "/api/custom-providers", {
      name: "Qwen LiteLLM",
      apiType: "openai-compatible",
      baseUrl: "https://litellm.example.com/v1",
      models: [{ id: "qwen3", name: "Qwen3", thinkingFormat: "bogus-format" }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid models[0].thinkingFormat "bogus-format". Allowed:');
    expect(res.body.error).toContain("qwen-chat-template");
    expect(settings.customProviders).toBeUndefined();
  });

  it("POST /custom-providers rejects a non-boolean reasoning (RUFU-143)", async () => {
    const app = createApp(settings);

    const res = await REQUEST(app, "POST", "/api/custom-providers", {
      name: "Qwen LiteLLM",
      apiType: "openai-compatible",
      baseUrl: "https://litellm.example.com/v1",
      models: [{ id: "qwen3", name: "Qwen3", reasoning: "no" }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("models[0].reasoning must be a boolean");
  });

  it("PUT /custom-providers/:id persists per-model thinking flags (RUFU-143)", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "Qwen LiteLLM",
        apiType: "openai-compatible",
        baseUrl: "https://litellm.example.com/v1",
        apiKey: "sk-qwen-1234",
        models: [{ id: "qwen3", name: "Qwen3" }],
      },
    ];
    const updates: Array<Partial<GlobalSettings>> = [];
    const app = createApp(settings, (patch) => updates.push(patch));

    const res = await REQUEST(app, "PUT", "/api/custom-providers/cp-1", {
      models: [{ id: "qwen3", name: "Qwen3", thinkingFormat: "deepseek", reasoning: true }],
    });

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([{ id: "qwen3", name: "Qwen3", thinkingFormat: "deepseek", reasoning: true }]);
    const persisted = updates[0].customProviders as CustomProvider[];
    expect(persisted[0]?.models).toEqual([{ id: "qwen3", name: "Qwen3", thinkingFormat: "deepseek", reasoning: true }]);
  });

  it("refresh-models preserves prior thinkingFormat and reasoning opt-out, never pre-filling from the probe (RUFU-143)", async () => {
    settings.customProviders = [
      {
        id: "cp-1",
        name: "Qwen LiteLLM",
        apiType: "openai-compatible",
        baseUrl: "https://litellm.example.com/v1",
        apiKey: "sk-qwen-1234",
        models: [
          { id: "qwen3", name: "Qwen3", thinkingFormat: "qwen-chat-template", reasoning: false },
          { id: "reasoning-o1", name: "Reasoning O1" },
          { id: "prior-true", name: "Prior True", reasoning: true },
        ],
      },
    ];
    // The probe reports no thinkingFormat and guesses reasoning=true for the "o1"/"reason" ids —
    // neither guess may be persisted. No limit objects, so windows are all undefined too.
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "qwen3", name: "Qwen3" },
          { id: "reasoning-o1", name: "Reasoning O1" },
          { id: "prior-true", name: "Prior True" },
        ],
      }),
    })));
    const app = createApp(settings);

    const res = await REQUEST(app, "POST", "/api/custom-providers/cp-1/refresh-models");

    expect(res.status).toBe(200);
    expect(settings.customProviders?.[0]?.models).toEqual([
      // Prior thinkingFormat + reasoning opt-out survive the re-probe.
      { id: "qwen3", name: "Qwen3", thinkingFormat: "qwen-chat-template", reasoning: false },
      // The probe's reasoning:true heuristic ("reason"/"o1" in the id) is NOT pre-filled.
      { id: "reasoning-o1", name: "Reasoning O1" },
      // A prior explicit reasoning:true is not re-emitted — the default is already presumed-capable.
      { id: "prior-true", name: "Prior True" },
    ]);
  });
});
