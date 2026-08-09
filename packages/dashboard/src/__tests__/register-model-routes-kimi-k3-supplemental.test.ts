import type { Router } from "express";
import { describe, expect, it, vi } from "vitest";
import { createKimiModelCatalogRegistry } from "./_kimi-model-catalog-fixture.js";
import { registerModelRoutes } from "../routes/register-model-routes.js";

/*
FNXC:ModelCatalog 2026-08-09-10:27:
FN-8900 keeps dashboard-level K3 coverage on pi-ai's real bundled catalog instead of the live
ModelRegistry.refresh() path, which reproduced a roughly 300-second stall. The route still runs its
supplemental merge and provider/id dedupe branches through registerProvider, so K3 catalog regressions
remain visible without changing timeout budgets or adding retries.
*/

function createModelsHandler(modelRegistry: ReturnType<typeof createKimiModelCatalogRegistry>) {
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

async function getK3Rows(modelRegistry: ReturnType<typeof createKimiModelCatalogRegistry>) {
  const handler = createModelsHandler(modelRegistry);
  const json = vi.fn();

  await handler({}, { json });

  const response = json.mock.calls[0][0] as { models: Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number }> };
  return response.models.filter((model) => model.provider === "kimi-coding" && model.id === "k3");
}

describe("FN-8180: Kimi K3 /api/models catalog", () => {
  it("surfaces the native K3 model once for a configured Kimi provider", async () => {
    const k3Rows = await getK3Rows(createKimiModelCatalogRegistry());
    expect(k3Rows).toEqual([{ provider: "kimi-coding", id: "k3", name: "Kimi K3", reasoning: true, contextWindow: 1_048_576 }]);
  });

  it("dedupes a colliding native K3 row after the route's supplemental merges", async () => {
    const k3Rows = await getK3Rows(createKimiModelCatalogRegistry({ duplicateK3: true }));
    expect(k3Rows).toEqual([{ provider: "kimi-coding", id: "k3", name: "Kimi K3", reasoning: true, contextWindow: 1_048_576 }]);
  });

  it("makes a missing native K3 catalog row explicit instead of passing vacuously", async () => {
    const k3Rows = await getK3Rows(createKimiModelCatalogRegistry({ omitK3: true }));
    expect(k3Rows).toEqual([]);
  });
});
