import type { Router } from "express";
import { describe, expect, it, vi } from "vitest";
import { registerModelRoutes } from "../routes/register-model-routes.js";

const ANTHROPIC_IDS = ["claude-opus-5-5", "claude-sonnet-5-5"];

type Model = { id: string; name: string; reasoning: boolean; input: string[]; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow: number; maxTokens: number; thinkingLevelMap?: Record<string, string | null> };

function createAuthStorage(kind: "oauth" | "api_key") {
  const credential = { type: kind };
  return {
    reload: vi.fn(),
    getOAuthProviders: vi.fn(() => [{ id: "anthropic-subscription" }]),
    getApiKeyProviders: vi.fn(() => [{ id: "anthropic-api-key" }]),
    get: vi.fn((id: string) => id === (kind === "oauth" ? "anthropic-subscription" : "anthropic-api-key") ? credential : undefined),
    hasAuth: vi.fn((id: string) => id === "anthropic" || id === "anthropic-subscription"),
    hasApiKey: vi.fn((id: string) => kind === "api_key" && id === "anthropic-api-key"),
    getProviderEnv: vi.fn(() => ({})),
    getApiKey: vi.fn(async () => undefined),
  };
}

function createRegistry(initialModels: Model[], throwOnMerge = false) {
  const registeredProviders = new Map<string, { models: Model[] }>([["anthropic", { models: initialModels }]]);
  return {
    registeredProviders,
    refresh: vi.fn(),
    registerProvider: vi.fn((provider: string, config: { models: Model[] }) => {
      if (throwOnMerge && provider === "anthropic") throw new Error("merge unavailable");
      registeredProviders.set(provider, config);
    }),
    getAll: vi.fn(() => (registeredProviders.get("anthropic")?.models ?? []).map((model) => ({ ...model, provider: "anthropic" }))),
    getAvailable: vi.fn(() => (registeredProviders.get("anthropic")?.models ?? []).map((model) => ({ ...model, provider: "anthropic" }))),
  };
}

function createModelsHandler(registry: ReturnType<typeof createRegistry>, authStorage: ReturnType<typeof createAuthStorage>) {
  const handlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = { post: vi.fn(), get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => handlers.set(path, handler)) } as unknown as Router;
  registerModelRoutes({
    router,
    store: { getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }), getSettingsFast: vi.fn().mockResolvedValue({}) } as never,
    runtimeLogger: { child: vi.fn(() => ({ warn: vi.fn() })) } as never,
    options: { modelRegistry: registry, authStorage } as never,
  } as never);
  return handlers.get("/models")!;
}

async function callModels(handler: ReturnType<typeof createModelsHandler>) {
  const json = vi.fn();
  await handler({}, { json });
  return json.mock.calls[0][0] as { models: Array<{ provider: string; id: string; name: string; supportedThinkingLevels?: string[] }> };
}

describe("FN-9440: supplemental Anthropic 5.5 models — /api/models", () => {
  it.each(["oauth", "api_key"] as const)("returns both direct Anthropic rows exactly once for %s credentials without exposing credential-card providers", async (credentialKind) => {
    const response = await callModels(createModelsHandler(createRegistry([]), createAuthStorage(credentialKind)));
    const rows = response.models.filter((model) => model.provider === "anthropic" && ANTHROPIC_IDS.includes(model.id));

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining(ANTHROPIC_IDS));
    expect(rows.every((row) => row.supportedThinkingLevels?.includes("xhigh") && row.supportedThinkingLevels?.includes("max"))).toBe(true);
    expect(response.models.some((model) => model.provider === "anthropic-subscription" || model.provider === "anthropic-api-key")).toBe(false);
  });

  it("keeps an upstream model row unchanged and singular", async () => {
    const upstream: Model = { id: "claude-opus-5-5", name: "Upstream Opus", reasoning: true, input: ["text"], cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 }, contextWindow: 12, maxTokens: 3, thinkingLevelMap: { max: "upstream" } };
    const response = await callModels(createModelsHandler(createRegistry([upstream]), createAuthStorage("oauth")));
    const rows = response.models.filter((model) => model.provider === "anthropic" && model.id === upstream.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Upstream Opus");
  });

  it("serves retained catalog rows when the supplemental merge fails", async () => {
    const existing: Model = { id: "claude-existing", name: "Existing Claude", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100, maxTokens: 10 };
    const response = await callModels(createModelsHandler(createRegistry([existing], true), createAuthStorage("oauth")));

    expect(response.models).toContainEqual(expect.objectContaining({ provider: "anthropic", id: "claude-existing" }));
  });
});
