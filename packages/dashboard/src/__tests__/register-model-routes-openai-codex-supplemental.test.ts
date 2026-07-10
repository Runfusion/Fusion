/*
FNXC:ModelCatalog 2026-07-09-12:30:
FN-7745 symptom verification: `/api/models` must surface the three GPT-5.6 codenamed
OpenAI Codex variants (gpt-5.6-luna/sol/terra) under provider "openai-codex" once that
provider is configured, additively and deduped against any pinned-catalog row that
already carries one of the ids — mirroring the mergeSupplementalAnthropicModels seam.
Pre-fix (before mergeSupplementalOpenAiCodexModels was wired into the route), a mocked
registry lacking these ids would never surface them even with openai-codex configured;
this suite encodes that failing-before/passing-after contract plus dedupe and the
configuredProviders allow-list gate.
*/
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Router } from "express";
import { describe, expect, it, vi } from "vitest";
import { registerModelRoutes } from "../routes/register-model-routes.js";

const GPT_5_6_IDS = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"];
const BUILT_IN_CODEX_IDS = ["gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5"];
const OPENAI_CODEX_OAUTH_CREDENTIAL = {
  refresh: "test-refresh-token",
  access: "test-access-token",
  expires: Date.now() + 60_000,
};
const OPENAI_CODEX_OAUTH_PROVIDER = {
  id: "openai-codex",
  name: "ChatGPT Plus/Pro (Codex Subscription)",
  login: async () => OPENAI_CODEX_OAUTH_CREDENTIAL,
  refreshToken: async () => OPENAI_CODEX_OAUTH_CREDENTIAL,
  getApiKey: () => OPENAI_CODEX_OAUTH_CREDENTIAL.access,
};

function createOpenAiCodexAuthStorage(openAiCodexConfigured: boolean) {
  const credential = {
    type: "oauth",
    access: "test-access-token",
    refresh: "test-refresh-token",
    expires: Date.now() + 60_000,
  };

  return {
    reload: vi.fn(),
    getOAuthProviders: vi.fn(() => [OPENAI_CODEX_OAUTH_PROVIDER]),
    getApiKeyProviders: vi.fn(() => []),
    get: vi.fn((providerId: string) => openAiCodexConfigured && providerId === "openai-codex" ? credential : undefined),
    hasAuth: vi.fn((providerId: string) => openAiCodexConfigured && providerId === "openai-codex"),
    hasApiKey: vi.fn(() => false),
    getProviderEnv: vi.fn(() => ({})),
    getApiKey: vi.fn(async (providerId: string) => openAiCodexConfigured && providerId === "openai-codex" ? credential.access : undefined),
  };
}

function createRealModelRegistryWithLegacyCodexCatalog(authStorage: ReturnType<typeof createOpenAiCodexAuthStorage>) {
  const registry = ModelRegistry.inMemory(authStorage as never) as unknown as ModelRegistry & { models: Array<Record<string, unknown>> };
  registry.models = registry.models.filter((model) => model.provider !== "openai-codex" || !GPT_5_6_IDS.includes(String(model.id)));
  return registry;
}

interface FakeOpenAiCodexModel {
  id: string;
  name: string;
  reasoning: boolean;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: unknown;
}

function createFakeModelRegistry(initialOpenAiCodexModels: FakeOpenAiCodexModel[]) {
  const registeredProviders = new Map<string, { name?: string; baseUrl?: string; api?: string; apiKey?: string; models: FakeOpenAiCodexModel[] }>();
  if (initialOpenAiCodexModels.length > 0) {
    registeredProviders.set("openai-codex", { models: initialOpenAiCodexModels });
  }

  return {
    refresh: vi.fn(),
    registeredProviders,
    registerProvider: vi.fn((providerName: string, config: { models: FakeOpenAiCodexModel[] }) => {
      registeredProviders.set(providerName, { ...registeredProviders.get(providerName), ...config });
    }),
    getAll: vi.fn(() => {
      const rows: Array<{ id: string; provider: string }> = [];
      for (const [providerName, config] of registeredProviders) {
        for (const model of config.models) {
          rows.push({ id: model.id, provider: providerName });
        }
      }
      return rows;
    }),
    getAvailable: vi.fn(() => {
      const rows: Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number }> = [
        { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 },
      ];
      for (const [providerName, config] of registeredProviders) {
        for (const model of config.models) {
          rows.push({ provider: providerName, id: model.id, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow });
        }
      }
      return rows;
    }),
  };
}

function createRouterHarness(modelRegistry: ReturnType<typeof createFakeModelRegistry> | ModelRegistry, options: { openAiCodexConfigured: boolean }, authStorage = createOpenAiCodexAuthStorage(options.openAiCodexConfigured)) {
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
  } as unknown as Router;

  const store = {
    getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }),
    getSettingsFast: vi.fn().mockResolvedValue({}),
  };

  const runtimeLogger = { child: vi.fn(() => ({ warn: vi.fn() })) };

  registerModelRoutes({
    router,
    store: store as never,
    runtimeLogger: runtimeLogger as never,
    options: { modelRegistry, authStorage } as never,
  } as never);

  return getHandlers.get("/models")!;
}

async function callModels(handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) {
  const json = vi.fn();
  await handler({}, { json });
  return json.mock.calls[0][0] as { models: Array<{ provider: string; id: string }> };
}

describe("FN-7745: GPT-5.6 codenamed OpenAI Codex variants — /api/models", () => {
  it("surfaces all three ids under openai-codex when the pinned catalog lacks them and the provider is configured", async () => {
    const modelRegistry = createFakeModelRegistry([]);
    const handler = createRouterHarness(modelRegistry, { openAiCodexConfigured: true });

    // Pre-fix failing assertion: without the merge wired in, none of the ids
    // would be present. Post-fix, all three must surface.
    const response = await callModels(handler);
    const codexIds = response.models.filter((m) => m.provider === "openai-codex").map((m) => m.id);
    expect(codexIds).toEqual(expect.arrayContaining(GPT_5_6_IDS));
  });

  it("does not duplicate an id already present in the pinned catalog — existing row wins", async () => {
    const modelRegistry = createFakeModelRegistry([
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna (pinned catalog)", reasoning: true, contextWindow: 272000, maxTokens: 128000 },
    ]);
    const handler = createRouterHarness(modelRegistry, { openAiCodexConfigured: true });

    const response = await callModels(handler);
    const codexRows = response.models.filter((m) => m.provider === "openai-codex");
    const lunaRows = codexRows.filter((m) => m.id === "gpt-5.6-luna");

    // Exactly one row for the pre-existing id — no duplicate provider/id key.
    expect(lunaRows).toHaveLength(1);
    expect(lunaRows[0]!.name).toBe("GPT-5.6 Luna (pinned catalog)");

    // The two still-missing ids must have been additively merged in.
    const allCodexIds = codexRows.map((m) => m.id);
    expect(allCodexIds).toEqual(expect.arrayContaining(["gpt-5.6-sol", "gpt-5.6-terra"]));

    // No double-listing of any provider/id key anywhere in the response.
    const keys = response.models.map((m) => `${m.provider}/${m.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not surface the rows when openai-codex is not among the configured providers", async () => {
    const modelRegistry = createFakeModelRegistry([]);
    const handler = createRouterHarness(modelRegistry, { openAiCodexConfigured: false });

    const response = await callModels(handler);
    expect(response.models.some((m) => m.provider === "openai-codex")).toBe(false);
  });

  it("drives the real ModelRegistry path from supplemental merge through /api/models filtering", async () => {
    const authStorage = createOpenAiCodexAuthStorage(true);
    const modelRegistry = createRealModelRegistryWithLegacyCodexCatalog(authStorage);
    const beforeIds = modelRegistry.getAvailable()
      .filter((model) => model.provider === "openai-codex")
      .map((model) => model.id);
    expect(beforeIds).not.toEqual(expect.arrayContaining(GPT_5_6_IDS));
    expect(beforeIds).toEqual(expect.arrayContaining(BUILT_IN_CODEX_IDS));

    const handler = createRouterHarness(modelRegistry, { openAiCodexConfigured: true }, authStorage);

    const response = await callModels(handler);
    const codexRows = response.models.filter((m) => m.provider === "openai-codex");
    const codexIds = codexRows.map((m) => m.id);
    expect(codexIds).toEqual(expect.arrayContaining([...BUILT_IN_CODEX_IDS, ...GPT_5_6_IDS]));

    const keys = response.models.map((m) => `${m.provider}/${m.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps real-registry GPT-5.6 rows gated when openai-codex auth is absent", async () => {
    const authStorage = createOpenAiCodexAuthStorage(false);
    const modelRegistry = createRealModelRegistryWithLegacyCodexCatalog(authStorage);
    const handler = createRouterHarness(modelRegistry, { openAiCodexConfigured: false }, authStorage);

    const response = await callModels(handler);
    expect(response.models.some((m) => m.provider === "openai-codex")).toBe(false);
  });
});
