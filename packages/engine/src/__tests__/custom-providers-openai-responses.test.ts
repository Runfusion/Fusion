import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { customProviderRegistryKey, type CustomProvider } from "@fusion/core";
import { readCustomProviders } from "../auth/custom-providers.js";

async function createInMemoryModelRegistry(): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({
    credentials: { read: async () => undefined, list: async () => [], modify: async (_id, fn) => fn(undefined), delete: async () => undefined },
    modelsPath: null,
    allowModelNetwork: false,
  });
  return new ModelRegistry(runtime);
}

describe("custom providers openai-responses regression", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "fn-custom-providers-responses-"));
    await mkdir(join(homeDir, ".pi", "fusion"), { recursive: true });
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("loads openai-responses providers from active global settings path and resolves model", async () => {
    const providers: CustomProvider[] = [
      {
        id: "550e8400-e29b-41d4-a716-446655440002",
        name: "MyAPI",
        apiType: "openai-responses",
        baseUrl: "https://responses.example.test/v1",
        apiKey: "RESPONSES_KEY",
        models: [{ id: "gpt-5.4", name: "GPT 5.4" }],
      },
    ];

    await writeFile(
      join(homeDir, ".pi", "fusion", "settings.json"),
      JSON.stringify({ customProviders: providers }),
      "utf-8",
    );

    const loadedProviders = readCustomProviders(homeDir);
    expect(loadedProviders).toEqual(providers);

    const modelRegistry = await createInMemoryModelRegistry();

    const provider = loadedProviders[0]!;
    modelRegistry.registerProvider(customProviderRegistryKey(provider, loadedProviders), {
      baseUrl: provider.baseUrl,
      api: "openai-responses",
      apiKey: provider.apiKey,
      models: [{
        id: "gpt-5.4",
        name: "GPT 5.4",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      }],
    });
    await modelRegistry.refresh();

    expect(modelRegistry.find("myapi", "gpt-5.4")).toBeDefined();
  });
});
