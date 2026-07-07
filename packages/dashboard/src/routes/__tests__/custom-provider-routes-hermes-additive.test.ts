// @vitest-environment node

/*
FNXC:ProviderAuth 2026-07-07-08:30:
FN-7630 (GitHub #1931) symptom verification: reproduces the exact reported
condition — a persisted customProviders entry (with a model) AND the Hermes
Runtime plugin loaded/connected — and asserts the persisted customProviders
list is byte-for-byte unchanged and never deactivated by the Hermes plugin's
lifecycle hooks. This closes the loop with register-model-routes-hermes-
additive.test.ts (model-picker surface) and register-auth-routes-hermes-
additive.test.ts (auth surface).
*/

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

// Mock the Hermes plugin's own CLI/skill-install seams so its real onLoad/
// onUnload hooks can run without spawning a real subprocess or touching disk.
const { mockResolveCli, mockInstallFusionSkill } = vi.hoisted(() => ({
  mockResolveCli: vi.fn().mockReturnValue({
    binaryPath: "hermes",
    model: undefined,
    provider: undefined,
    maxTurns: 12,
    yolo: false,
    cliTimeoutMs: 300_000,
    profile: undefined,
  }),
  mockInstallFusionSkill: vi.fn().mockReturnValue({
    outcome: "installed",
    sourceDir: "/tmp/source",
    targetDir: "/tmp/target",
  }),
}));

vi.mock("@fusion-plugin-examples/hermes-runtime/dist/cli-spawn.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@fusion-plugin-examples/hermes-runtime/dist/cli-spawn.js");
  return { ...actual, resolveCliSettings: mockResolveCli };
});
vi.mock("@fusion-plugin-examples/hermes-runtime/dist/fusion-skill-install.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@fusion-plugin-examples/hermes-runtime/dist/fusion-skill-install.js");
  return { ...actual, installFusionSkillIntoHermesHome: mockInstallFusionSkill };
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
): Promise<{ status: number; body: unknown }> {
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

describe("FN-7630 symptom verification: customProviders + Hermes runtime connected", () => {
  beforeEach(() => {
    mockInvalidateAllGlobalSettingsCaches.mockReset();
    vi.unstubAllGlobals();
  });

  it("leaves the persisted customProviders list byte-identical across the Hermes plugin's onLoad/onUnload lifecycle", async () => {
    const persistedProvider: CustomProvider = {
      id: "cp-symptom-1",
      name: "Symptom Provider",
      apiType: "openai-compatible",
      baseUrl: "https://example.com",
      apiKey: "sk-test-1234567890",
      models: [{ id: "symptom-model-1", name: "Symptom Model 1" }],
    };
    const settings: GlobalSettings = { customProviders: [persistedProvider] };
    const app = createApp(settings);

    const before = await REQUEST(app, "GET", "/api/custom-providers");
    expect(before.status).toBe(200);
    const beforeBody = before.body as CustomProvider[];
    expect(beforeBody).toHaveLength(1);
    expect(beforeBody[0]?.models).toEqual([{ id: "symptom-model-1", name: "Symptom Model 1" }]);

    // Connect (load) then disconnect (unload) the real Hermes plugin around
    // the CRUD call — reproducing "activate/disconnect the Hermes runtime".
    const hermesPlugin = (await import("@fusion-plugin-examples/hermes-runtime")).default;
    const ctx = {
      pluginId: "fusion-plugin-hermes-runtime",
      settings: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent: vi.fn(),
      taskStore: { getTask: vi.fn() },
    };
    await hermesPlugin.hooks!.onLoad!(ctx as never);

    const during = await REQUEST(app, "GET", "/api/custom-providers");
    expect(during.status).toBe(200);
    expect(during.body).toEqual(beforeBody);
    // The persisted settings object itself (source of truth) must be untouched.
    expect(settings.customProviders).toEqual([persistedProvider]);

    await hermesPlugin.hooks!.onUnload!(ctx as never);

    const after = await REQUEST(app, "GET", "/api/custom-providers");
    expect(after.status).toBe(200);
    expect(after.body).toEqual(beforeBody);
    expect(settings.customProviders).toEqual([persistedProvider]);
  });

  it("leaves an empty customProviders list unaffected by a connected Hermes runtime", async () => {
    const settings: GlobalSettings = { customProviders: [] };
    const app = createApp(settings);

    const hermesPlugin = (await import("@fusion-plugin-examples/hermes-runtime")).default;
    await hermesPlugin.hooks!.onLoad!({
      pluginId: "fusion-plugin-hermes-runtime",
      settings: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent: vi.fn(),
      taskStore: { getTask: vi.fn() },
    } as never);

    const res = await REQUEST(app, "GET", "/api/custom-providers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(settings.customProviders).toEqual([]);
  });

  it("leaves multiple customProviders unaffected by a connected Hermes runtime", async () => {
    const providers: CustomProvider[] = [
      { id: "cp-a", name: "Provider A", apiType: "openai-compatible", baseUrl: "https://a.example.com", models: [{ id: "model-a", name: "Model A" }] },
      { id: "cp-b", name: "Provider B", apiType: "google-generative-ai", baseUrl: "https://b.example.com", models: [{ id: "model-b", name: "Model B" }] },
    ];
    const settings: GlobalSettings = { customProviders: providers };
    const app = createApp(settings);

    const hermesPlugin = (await import("@fusion-plugin-examples/hermes-runtime")).default;
    await hermesPlugin.hooks!.onLoad!({
      pluginId: "fusion-plugin-hermes-runtime",
      settings: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent: vi.fn(),
      taskStore: { getTask: vi.fn() },
    } as never);

    const res = await REQUEST(app, "GET", "/api/custom-providers");
    expect(res.status).toBe(200);
    expect((res.body as CustomProvider[])).toHaveLength(2);
    expect(settings.customProviders).toEqual(providers);
  });
});
