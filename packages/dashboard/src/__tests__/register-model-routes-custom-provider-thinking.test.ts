import { THINKING_LEVELS } from "@fusion/core";
import type { Router } from "express";
import { describe, expect, it, vi } from "vitest";
import { registerModelRoutes } from "../routes/register-model-routes.js";

type RegistryModel = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: { xhigh?: string | null; max?: string | null };
  contextWindow: number;
};

function createModelsHandler(models: RegistryModel[]) {
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    post: vi.fn(),
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
  } as unknown as Router;
  const registry = {
    refresh: vi.fn(),
    getAvailable: vi.fn(() => models),
    getAll: vi.fn(() => models),
  };

  const customProviders = [...new Set(models.map((model) => model.provider))].map((provider) => ({
    id: provider,
    name: provider,
    apiType: "openai-compatible" as const,
    baseUrl: "https://custom.example/v1",
    models: [],
  }));

  registerModelRoutes({
    router,
    store: {
      getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({ customProviders }) }),
      getSettingsFast: vi.fn().mockResolvedValue({}),
    } as never,
    runtimeLogger: { child: vi.fn(() => ({ warn: vi.fn() })) } as never,
    options: { modelRegistry: registry } as never,
  } as never);

  return getHandlers.get("/models")!;
}

async function getModels(handler: ReturnType<typeof createModelsHandler>) {
  const json = vi.fn();
  await handler({}, { json });
  return json.mock.calls[0][0] as { models: Array<RegistryModel & { supportedThinkingLevels?: string[] }> };
}

describe("custom-provider thinking levels on /api/models", () => {
  it("emits the complete canonical list from a custom-provider registration", async () => {
    const response = await getModels(createModelsHandler([{
      provider: "custom-provider",
      id: "custom-model",
      name: "Custom Model",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      contextWindow: 128_000,
    }]));

    expect(response.models).toContainEqual(expect.objectContaining({
      provider: "custom-provider",
      id: "custom-model",
      reasoning: true,
      supportedThinkingLevels: THINKING_LEVELS,
    }));
  });

  it("keeps catalog non-thinking models off-only", async () => {
    const response = await getModels(createModelsHandler([{
      provider: "catalog",
      id: "non-thinking-model",
      name: "Non-thinking Model",
      reasoning: false,
      contextWindow: 128_000,
    }]));

    expect(response.models).toContainEqual(expect.objectContaining({
      provider: "catalog",
      id: "non-thinking-model",
      reasoning: false,
      supportedThinkingLevels: ["off"],
    }));
  });
});
