import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { completeSimple } from "@earendil-works/pi-ai/compat";
/*
FNXC:Dependencies 2026-07-01-08:16:
The pi 0.80 SDK keeps compatibility helpers under ./compat and exposes provider internals through the documented ./api/* export map instead of the previous root-level openai-completions subpath.
*/
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { customProviderRegistryKey, type CustomProvider } from "@fusion/core";
import { buildCustomProviderModels, resolveApiType } from "../auth/custom-provider-registry.js";
import { createInMemoryModelRegistry, warmSharedModelRuntime } from "./_model-runtime-fixture.js";

function createSseResponse(): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello from mock transport\"},\"finish_reason\":null}]}\n\n"));
      controller.enqueue(new TextEncoder().encode("data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n"));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}


beforeAll(async () => {
  await warmSharedModelRuntime();
});

describe("custom providers openai-completions regression", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("registers under slug key and completes a chat round-trip", async () => {
    const modelRegistry = await createInMemoryModelRegistry();
    const providers: CustomProvider[] = [{
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "My AI Provider",
      apiType: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKey: "CUSTOM_KEY",
      models: [{ id: "my-model", name: "My Model" }],
    }];

    const provider = providers[0]!;
    modelRegistry.registerProvider(customProviderRegistryKey(provider, providers), {
      baseUrl: provider.baseUrl,
      api: "openai-completions",
      apiKey: provider.apiKey,
      models: [{ id: "my-model", name: "My Model", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 }],
    });
    await modelRegistry.refresh();

    const registered = modelRegistry.getAll().find((model) => model.id === "my-model");
    expect(registered?.provider).toBe("my-ai-provider");

    vi.stubGlobal("fetch", vi.fn(async () => createSseResponse()));
    const model = modelRegistry.find("my-ai-provider", "my-model");
    const response = await completeSimple(model!, { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] });
    expect(response.role).toBe("assistant");
  });

  it("uses system role when reasoning model explicitly disables developer role compat", () => {
    const params = convertMessages(
      { provider: "openai", reasoning: true, input: ["text"] } as never,
      { systemPrompt: "system instruction", messages: [] } as never,
      { supportsDeveloperRole: false } as never,
    );
    expect(params[0]?.role).toBe("system");
  });

  it("emits developer role when compat allows it on reasoning models", () => {
    const params = convertMessages(
      { provider: "openai", reasoning: true, input: ["text"] } as never,
      { systemPrompt: "system instruction", messages: [] } as never,
      { supportsDeveloperRole: true } as never,
    );
    expect(params[0]?.role).toBe("developer");
  });
});

/*
FNXC:CustomProviderModelWindows 2026-08-19-13:03:
RUFU-123: end-to-end proof that a settings-declared per-model window flows through
buildCustomProviderModels (the shared builder of registerCustomProviders/
reregisterCustomProviders) into a real pi-ai ModelRegistry — the old hardcoded
128000/16384 is gone for models that carry explicit values, while a model without
declared values keeps the defaults.
*/
describe("RUFU-123: settings-declared per-model windows reach the registry", () => {
  it("registers 32768/4096 from the settings entry and keeps 128000/16384 for a model without windows", async () => {
    const modelRegistry = await createInMemoryModelRegistry();
    const providers: CustomProvider[] = [{
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "RUFU-123 Provider",
      apiType: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKey: "CUSTOM_KEY",
      models: [
        { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 32768, maxTokens: 4096 },
        { id: "legacy-model", name: "Legacy Model" },
      ],
    }];

    const provider = providers[0]!;
    const api = resolveApiType(provider.apiType);
    modelRegistry.registerProvider(customProviderRegistryKey(provider, providers), {
      baseUrl: provider.baseUrl,
      api,
      apiKey: provider.apiKey,
      models: buildCustomProviderModels(provider, api),
    });
    await modelRegistry.refresh();

    const perModel = modelRegistry.getAll().find((model) => model.id === "deepseek-v4");
    expect(perModel?.contextWindow).toBe(32768);
    expect(perModel?.maxTokens).toBe(4096);

    const legacy = modelRegistry.getAll().find((model) => model.id === "legacy-model");
    expect(legacy?.contextWindow).toBe(128000);
    expect(legacy?.maxTokens).toBe(16384);
  });
});
