import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
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

/*
FNXC:CustomProviderThinkingFormat 2026-08-21-05:30:
RUFU-143: per-model thinking flags. The builder honors the per-model `reasoning: false`
opt-out (no thinkingLevelMap, reasoning:false) and emits `compat.thinkingFormat` only for
openai-completions models (the only pi-ai api compat surface with the field). The wire
cases prove the pi-ai 0.84.1 contract end-to-end: qwen-chat-template emits
chat_template_kwargs { enable_thinking, preserve_thinking } and NEVER reasoning_effort
(the LiteLLM/Qwen3 400 this task fixes); an opted-out model emits no thinking parameter at
any level; an unflagged model still emits reasoning_effort (the default the opt-out
exists to escape).
*/
describe("RUFU-143: per-model thinking flags", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeProvider(modelFlags: Record<string, unknown> = {}, apiType: string = "openai-compatible"): CustomProvider {
    return {
      id: "e00e8400-e29b-41d4-a716-446655440143",
      name: "Qwen LiteLLM",
      apiType,
      baseUrl: "https://litellm.test/v1",
      apiKey: "CUSTOM_KEY",
      models: [{ id: "qwen3", name: "Qwen3", ...modelFlags }],
    };
  }

  it("registers an unflagged model byte-identically to the presumed-thinking-capable default", () => {
    const [model] = buildCustomProviderModels(makeProvider(), "openai-completions");
    expect(model).toEqual({
      id: "qwen3",
      name: "Qwen3",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
      compat: { supportsDeveloperRole: false },
    });
  });

  it("emits compat.thinkingFormat for an openai-compatible model set to qwen-chat-template", () => {
    const [model] = buildCustomProviderModels(makeProvider({ thinkingFormat: "qwen-chat-template" }), "openai-completions");
    expect(model).toMatchObject({
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      compat: { supportsDeveloperRole: false, thinkingFormat: "qwen-chat-template" },
    });
  });

  it("emits thinkingFormat for openai-completions only (zai: completions yes, responses no)", () => {
    const [completions] = buildCustomProviderModels(makeProvider({ thinkingFormat: "zai" }), "openai-completions");
    const [responses] = buildCustomProviderModels(makeProvider({ thinkingFormat: "zai" }, "openai-responses"), "openai-responses");
    expect(completions?.compat?.thinkingFormat).toBe("zai");
    expect(responses).toBeTruthy();
    // openai-responses models carry no compat block at all (the builder only emits one
    // for openai-completions), so thinkingFormat cannot leak in.
    expect(responses?.compat).toBeUndefined();
  });

  it("opt-out (reasoning: false) strips thinkingLevelMap and wins over thinkingFormat", () => {
    const [model] = buildCustomProviderModels(
      makeProvider({ thinkingFormat: "qwen-chat-template", reasoning: false }),
      "openai-completions",
    );
    expect(model).toMatchObject({ reasoning: false });
    expect(model).not.toHaveProperty("thinkingLevelMap");
    expect(model?.compat).not.toHaveProperty("thinkingFormat");
    expect(getSupportedThinkingLevels(model)).toEqual(["off"]);
  });

  it("treats an explicit reasoning: true like the absent default", () => {
    const [model] = buildCustomProviderModels(makeProvider({ reasoning: true }), "openai-completions");
    expect(model).toMatchObject({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
    expect(model?.compat).not.toHaveProperty("thinkingFormat");
  });

  async function registerAndComplete(
    modelFlags: Record<string, unknown>,
    reasoning: "high" | "off",
  ): Promise<Record<string, unknown>> {
    const modelRegistry = await createInMemoryModelRegistry();
    const provider = makeProvider(modelFlags);
    const api = resolveApiType(provider.apiType);
    modelRegistry.registerProvider(customProviderRegistryKey(provider, [provider]), {
      baseUrl: provider.baseUrl,
      api,
      apiKey: provider.apiKey,
      models: buildCustomProviderModels(provider, api),
    });
    await modelRegistry.refresh();

    const fetchSpy = vi.fn(async () => createSseResponse());
    vi.stubGlobal("fetch", fetchSpy);

    const model = modelRegistry.find("qwen-litellm", "qwen3");
    expect(model).toBeTruthy();
    /*
    FNXC:CustomProviderThinkingFormat 2026-08-21-05:30:
    RUFU-143: the options argument carries the apiKey (the in-memory ModelRuntime in the
    fixture has no credentials) and the thinking level; "high" is natively supported by the
    canonical level map, so the wire carries the requested level unclamped.
    */
    const response = await completeSimple(
      model!,
      { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
      { apiKey: "CUSTOM_KEY", reasoning },
    );
    expect(response.stopReason, response.errorMessage).not.toBe("error");

    return JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
  }

  it("qwen-chat-template sends chat_template_kwargs and never reasoning_effort", async () => {
    const on = await registerAndComplete({ thinkingFormat: "qwen-chat-template" }, "high");
    expect(on.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
    expect(on).not.toHaveProperty("reasoning_effort");

    const off = await registerAndComplete({ thinkingFormat: "qwen-chat-template" }, "off");
    expect(off.chat_template_kwargs).toEqual({ enable_thinking: false, preserve_thinking: true });
    expect(off).not.toHaveProperty("reasoning_effort");
  });

  it("an opted-out model sends no thinking parameter at any level", async () => {
    for (const reasoning of ["high", "off"] as const) {
      const body = await registerAndComplete({ thinkingFormat: "qwen-chat-template", reasoning: false }, reasoning);
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("chat_template_kwargs");
      expect(body).not.toHaveProperty("enable_thinking");
      expect(body).not.toHaveProperty("thinking");
    }
  });

  it("an unflagged model still sends reasoning_effort (the default the opt-out escapes)", async () => {
    const body = await registerAndComplete({}, "high");
    expect(body.reasoning_effort).toBe("high");
    expect(body).not.toHaveProperty("chat_template_kwargs");
  });
});
