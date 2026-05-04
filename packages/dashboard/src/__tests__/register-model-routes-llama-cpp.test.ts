import { describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import { registerModelRoutes } from "../routes/register-model-routes.js";

function setup(useLlamaCpp?: boolean) {
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
  } as unknown as Router;

  const store = {
    getGlobalSettingsStore: () => ({
      getSettings: vi.fn().mockResolvedValue({ useLlamaCpp }),
    }),
    getSettingsFast: vi.fn().mockResolvedValue({}),
  };

  const runtimeLogger = {
    child: vi.fn(() => ({ warn: vi.fn() })),
  };

  const modelRegistry = {
    refresh: vi.fn(),
    getAvailable: vi.fn(() => [
      { provider: "llama-server", id: "llama3", name: "Llama 3", reasoning: true, contextWindow: 128000 },
      { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 },
    ]),
  };

  registerModelRoutes({
    router,
    store: store as never,
    runtimeLogger: runtimeLogger as never,
    options: { modelRegistry } as never,
  } as never);

  return { handler: getHandlers.get("/models")! };
}

describe("registerModelRoutes llama-server filter", () => {
  it("filters llama-server models when useLlamaCpp is false", async () => {
    const { handler } = setup(false);
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as { models: Array<{ provider: string }> };
    expect(response.models.some((model) => model.provider === "llama-server")).toBe(false);
  });

  it("includes llama-server models when useLlamaCpp is true", async () => {
    const { handler } = setup(true);
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as { models: Array<{ provider: string }> };
    expect(response.models.some((model) => model.provider === "llama-server")).toBe(true);
  });

  it("filters llama-server models when useLlamaCpp is unset", async () => {
    const { handler } = setup(undefined);
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as { models: Array<{ provider: string }> };
    expect(response.models.some((model) => model.provider === "llama-server")).toBe(false);
  });
});
