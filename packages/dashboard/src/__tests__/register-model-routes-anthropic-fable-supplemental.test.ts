/*
FNXC:ModelCatalog 2026-09-02-01:01:
Fable 5.1 must reach the shared /api/models picker boundary for both Anthropic
credential surfaces. Exercise the additive merge, duplicate, and failure paths here
because every task, agent, chat, and lane picker consumes this catalog response.
*/
import type { Router } from "express";
import { describe, expect, it, vi } from "vitest";
import { registerModelRoutes } from "../routes/register-model-routes.js";

const FABLE_5 = {
  id: "claude-fable-5",
  name: "Claude Fable 5",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

function createAuthStorage(authId: "anthropic-api-key" | "anthropic-subscription") {
  const credential = authId === "anthropic-api-key"
    ? { type: "api_key", key: "test-key" }
    : { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 60_000 };
  return {
    reload: vi.fn(),
    getOAuthProviders: vi.fn(() => authId === "anthropic-subscription" ? [{ id: authId }] : []),
    getApiKeyProviders: vi.fn(() => authId === "anthropic-api-key" ? [{ id: authId }] : []),
    get: vi.fn((id: string) => id === authId ? credential : undefined),
    hasAuth: vi.fn((id: string) => id === authId),
    hasApiKey: vi.fn((id: string) => id === authId && authId === "anthropic-api-key"),
    getProviderEnv: vi.fn(() => ({})),
    getApiKey: vi.fn(async () => undefined),
  };
}

function createRegistry(initialModels: any[], throwsOnRegister = false) {
  const registeredProviders = new Map<string, any>([["anthropic", { models: initialModels }]]);
  return {
    registeredProviders,
    refresh: vi.fn(),
    registerProvider: vi.fn((provider: string, config: any) => {
      if (throwsOnRegister) throw new Error("registration failed");
      registeredProviders.set(provider, { ...registeredProviders.get(provider), ...config });
    }),
    getAll: vi.fn(() => [...registeredProviders.entries()].flatMap(([provider, config]) => config.models.map((model: any) => ({ ...model, provider })))),
    getAvailable: vi.fn(() => [...registeredProviders.entries()].flatMap(([provider, config]) => config.models.map((model: any) => ({ ...model, provider })))),
  };
}

function createModelsHandler(modelRegistry: ReturnType<typeof createRegistry>, authStorage: ReturnType<typeof createAuthStorage>) {
  const handlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    post: vi.fn(),
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => handlers.set(path, handler)),
  } as unknown as Router;
  const store = {
    getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }),
    getSettingsFast: vi.fn().mockResolvedValue({}),
  };
  registerModelRoutes({
    router,
    store: store as never,
    runtimeLogger: { child: vi.fn(() => ({ warn: vi.fn() })) } as never,
    options: { modelRegistry, authStorage } as never,
  } as never);
  return handlers.get("/models")!;
}

async function getModels(handler: ReturnType<typeof createModelsHandler>) {
  const json = vi.fn();
  await handler({}, { json });
  return json.mock.calls[0]![0] as { models: Array<{ provider: string; id: string; name: string; supportedThinkingLevels?: string[] }> };
}

describe("FN-9242: Claude Fable 5.1 supplemental Anthropic picker catalog", () => {
  it.each(["anthropic-api-key", "anthropic-subscription"] as const)("serves one direct Anthropic Fable 5.1 row for %s auth", async (authId) => {
    const response = await getModels(createModelsHandler(createRegistry([FABLE_5]), createAuthStorage(authId)));
    const rows = response.models.filter((model) => model.id === "claude-fable-5-1");

    expect(rows).toEqual([expect.objectContaining({ provider: "anthropic", id: "claude-fable-5-1", name: "Claude Fable 5.1" })]);
    expect(rows[0]?.supportedThinkingLevels).toEqual(expect.arrayContaining(["xhigh", "max"]));
    expect(rows[0]?.supportedThinkingLevels).not.toContain("off");
    expect(response.models.some((model) => model.provider === "anthropic-api-key" || model.provider === "anthropic-subscription")).toBe(false);
    expect(response.models.find((model) => model.id === FABLE_5.id)?.name).toBe(FABLE_5.name);
  });

  it("keeps an upstream Fable 5.1 catalog row without duplication", async () => {
    const upstream = { ...FABLE_5, id: "claude-fable-5-1", name: "Claude Fable 5.1 Upstream", contextWindow: 12_345 };
    const response = await getModels(createModelsHandler(createRegistry([FABLE_5, upstream]), createAuthStorage("anthropic-api-key")));
    const rows = response.models.filter((model) => model.provider === "anthropic" && model.id === upstream.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: upstream.name });
  });

  it("keeps the existing catalog available when supplemental registration fails", async () => {
    const response = await getModels(createModelsHandler(createRegistry([FABLE_5], true), createAuthStorage("anthropic-subscription")));

    expect(response.models).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "anthropic", id: FABLE_5.id, name: FABLE_5.name })]));
  });
});
