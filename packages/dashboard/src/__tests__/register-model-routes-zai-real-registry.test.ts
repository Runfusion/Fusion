import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  mergeBuiltInZaiProviderModels,
  registerBuiltInZaiProvider,
  ZAI_PROVIDER_REGISTRATION,
} from "@fusion/core";
import type { Router } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerModelRoutes } from "../routes/register-model-routes.js";

const EXISTING_ZAI_MODELS = [
  "glm-4.5-air",
  "glm-4.7",
  "glm-5-turbo",
  "glm-5.1",
  "glm-5v-turbo",
];

async function withTempHome() {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "fusion-zai-models-"));
  const authDir = join(home, ".fusion", "agent");
  await mkdir(authDir, { recursive: true });
  await writeFile(join(authDir, "auth.json"), JSON.stringify({ zai: { type: "api_key", key: "test-zai-key" } }));
  process.env.HOME = home;
  return () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  };
}

function createRouterHarness(modelRegistry: ModelRegistry) {
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
    options: { modelRegistry },
  } as never);

  return getHandlers.get("/models")!;
}

describe("registerModelRoutes Z.ai real registry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("surfaces glm-5.2 through /api/models after a user zai extension replacement", async () => {
    const restoreHome = await withTempHome();
    try {
      const authStorage = AuthStorage.inMemory({ zai: { type: "api_key", key: "test-zai-key" } });
      const modelRegistry = ModelRegistry.inMemory(authStorage);
      registerBuiltInZaiProvider(modelRegistry);

      modelRegistry.registerProvider("zai", {
        ...ZAI_PROVIDER_REGISTRATION,
        name: "User ZAI extension",
        models: ZAI_PROVIDER_REGISTRATION.models.filter((model) => model.id !== "glm-5.2"),
      });
      expect(modelRegistry.getAvailable().some((model) => model.provider === "zai" && model.id === "glm-5.2")).toBe(false);

      mergeBuiltInZaiProviderModels(modelRegistry);
      modelRegistry.refresh();

      const allZaiIds = modelRegistry.getAll().filter((model) => model.provider === "zai").map((model) => model.id);
      expect(allZaiIds).toEqual([...EXISTING_ZAI_MODELS, "glm-5.2"]);

      const handler = createRouterHarness(modelRegistry);
      const json = vi.fn();
      await handler({}, { json });

      const response = json.mock.calls[0][0] as { models: Array<{ provider: string; id: string }> };
      const zaiIds = response.models.filter((model) => model.provider === "zai").map((model) => model.id);
      expect(zaiIds).toEqual([...EXISTING_ZAI_MODELS, "glm-5.2"]);
    } finally {
      restoreHome();
    }
  });
});
