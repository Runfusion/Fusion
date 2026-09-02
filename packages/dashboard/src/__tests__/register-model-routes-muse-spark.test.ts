import type { Router } from "express";
import { describe, expect, it, vi } from "vitest";
import { registerModelRoutes } from "../routes/register-model-routes.js";

type ModelRow = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
};

function createRouterHarness(models: ModelRow[]) {
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
    post: vi.fn(),
  } as unknown as Router;
  const store = {
    getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }),
    getSettingsFast: vi.fn().mockResolvedValue({}),
  };
  const modelRegistry = {
    refresh: vi.fn(async () => undefined),
    getAvailable: vi.fn(() => models),
  };
  const runtimeLogger = { child: vi.fn(() => ({ warn: vi.fn() })) };
  const authStorage = {
    reload: vi.fn(),
    getOAuthProviders: vi.fn(() => []),
    getApiKeyProviders: vi.fn(() => models.map(({ provider }) => ({ id: provider }))),
    get: vi.fn(() => ({ type: "api_key", key: "test-key" })),
  };

  registerModelRoutes({
    router,
    store: store as never,
    runtimeLogger: runtimeLogger as never,
    options: { modelRegistry, authStorage },
  } as never);

  return getHandlers.get("/models")!;
}

const THINKING_MAP = {
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: null,
};

describe("registerModelRoutes Muse Spark catalog", () => {
  it("advertises credentialed Muse Spark rows with their supported thinking levels", async () => {
    const handler = createRouterHarness([
      { provider: "openrouter", id: "meta/muse-spark-1.2", name: "Muse Spark 1.2", reasoning: true, contextWindow: 1_048_576, thinkingLevelMap: THINKING_MAP },
      { provider: "opencode-go", id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor", reasoning: true, contextWindow: 1_048_576, thinkingLevelMap: THINKING_MAP },
    ]);
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0]![0] as { models: Array<{ provider: string; id: string; supportedThinkingLevels: string[] }> };
    for (const model of response.models) {
      expect(model.supportedThinkingLevels).toEqual(expect.arrayContaining(["high", "xhigh"]));
      expect(model.supportedThinkingLevels).not.toEqual(expect.arrayContaining(["off", "max"]));
    }
  });

  it("advertises a Vercel-shaped Muse Spark row with a defined empty thinking list", async () => {
    const handler = createRouterHarness([
      { provider: "vercel-ai-gateway", id: "meta/muse-spark-1.2", name: "Muse Spark 1.2", reasoning: true, contextWindow: 1_048_576 },
    ]);
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0]![0] as { models: Array<{ provider: string; id: string; supportedThinkingLevels?: string[] }> };
    expect(response.models).toEqual([
      expect.objectContaining({
        provider: "vercel-ai-gateway",
        id: "meta/muse-spark-1.2",
        supportedThinkingLevels: [],
      }),
    ]);
  });
});
