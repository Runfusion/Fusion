import type { Router } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerModelRoutes } from "../routes/register-model-routes.js";

/*
FNXC:ModelCatalog 2026-07-24-12:00:
FN-8564 requires Kimi K3 to reach both model-catalog consumers. This route-level
coverage uses Pi 0.82.0's actual built-in ModelRuntime catalog after refresh, so an
SDK catalog regression cannot leave the Dashboard dropdown missing K3 while the engine
registry test remains green.

FNXC:ModelCatalog 2026-08-01-05:17:
FN-8647 preserves the real SDK catalog while hoisting its construction to one reusable
per-file beforeAll seam, keeping future cases O(1) constructions per file. With one
case today this does not change wall-clock time or remove the >15s risk: beforeAll
inherits the same 15s hook budget. The test is quarantined while an owner decides that
budget; no timeout was widened.
*/

let nativeKimiRegistry: ModelRegistry;
let nativeKimiRegistryConstructionCount = 0;

async function createNativeKimiRegistry(): Promise<ModelRegistry> {
  nativeKimiRegistryConstructionCount += 1;
  const runtime = await ModelRuntime.create({
    credentials: {
      read: async (providerId) => providerId === "kimi-coding"
        ? { type: "api_key", key: "test-kimi-key" }
        : undefined,
      list: async () => [{ providerId: "kimi-coding", type: "api_key" }],
      modify: async (_providerId, fn) => fn(undefined),
      delete: async () => undefined,
    },
    modelsPath: null,
    allowModelNetwork: false,
  });
  return new ModelRegistry(runtime);
}

function createModelsHandler(modelRegistry: ModelRegistry) {
  const handlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      handlers.set(path, handler);
    }),
  } as unknown as Router;
  const authStorage = {
    reload: vi.fn(),
    getOAuthProviders: vi.fn(() => []),
    getApiKeyProviders: vi.fn(() => [{ id: "kimi-coding", name: "Kimi" }]),
    get: vi.fn(() => ({ type: "api_key", key: "test-kimi-key" })),
    hasApiKey: vi.fn((providerId: string) => providerId === "kimi-coding"),
    hasAuth: vi.fn((providerId: string) => providerId === "kimi-coding"),
  };

  registerModelRoutes({
    router,
    store: {
      getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }),
      getSettingsFast: vi.fn().mockResolvedValue({}),
    } as never,
    runtimeLogger: { child: vi.fn(() => ({ warn: vi.fn() })) } as never,
    options: { modelRegistry, authStorage } as never,
  } as never);

  return handlers.get("/models")!;
}

describe("FN-8180: Kimi K3 /api/models catalog", () => {
  beforeAll(async () => {
    nativeKimiRegistry = await createNativeKimiRegistry();
  });

  afterAll(() => {
    expect(nativeKimiRegistryConstructionCount).toBe(1);
  });

  it("surfaces the native K3 model once for a configured Kimi provider", async () => {
    const handler = createModelsHandler(nativeKimiRegistry);
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as { models: Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number }> };
    const k3Rows = response.models.filter((model) => model.provider === "kimi-coding" && model.id === "k3");
    expect(k3Rows).toEqual([{ provider: "kimi-coding", id: "k3", name: "Kimi K3", reasoning: true, contextWindow: 1_048_576 }]);
  });
});
