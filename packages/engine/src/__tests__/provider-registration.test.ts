import { afterEach, describe, expect, it, vi } from "vitest";
import { customProviderRegistryKey, type CustomProvider } from "@fusion/core";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { seedDashboardProviders } from "../auth/provider-registration.js";
import { registerCustomProviders } from "../auth/custom-provider-registry.js";

/*
FNXC:ProviderRegistration 2026-07-07-00:00:
FN-7622 regression coverage: asserts seedDashboardProviders() produces the SAME provider catalog the
CLI serve/dashboard/daemon commands produce (built-in API-key providers + any registered custom
provider) across the enumerated data states — customProviders undefined/[]/one/multiple — and that a
settings:updated change re-registers custom providers via the disposer-managed listener.
*/

function makeAuthStorage() {
  const credentials: Record<string, { type: string; key?: string }> = {};
  return {
    reload: vi.fn(),
    getOAuthProviders: vi.fn(() => []),
    hasAuth: vi.fn((provider: string) => Boolean(credentials[provider])),
    login: vi.fn(),
    logout: vi.fn((provider: string) => {
      delete credentials[provider];
    }),
    set: vi.fn((provider: string, credential: { type: string; key?: string }) => {
      credentials[provider] = credential;
    }),
    remove: vi.fn((provider: string) => {
      delete credentials[provider];
    }),
    get: vi.fn((provider: string) => credentials[provider]),
    getAll: vi.fn(() => ({ ...credentials })),
    list: vi.fn(() => Object.keys(credentials)),
    getApiKey: vi.fn(async (provider: string) => credentials[provider]?.key),
  } as any;
}

async function createInMemoryModelRegistry(): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({
    credentials: { read: async () => undefined, list: async () => [], modify: async (_id, fn) => fn(undefined), delete: async () => undefined },
    modelsPath: null,
    allowModelNetwork: false,
  });
  return new ModelRegistry(runtime);
}

function makeModelRegistry() {
  const registeredProviders = new Map<string, { models: Array<{ provider: string; id: string }> }>();
  return {
    registerProvider: vi.fn((name: string, config: { models?: Array<{ id: string }> }) => {
      registeredProviders.set(name, {
        models: (config.models ?? []).map((model) => ({ provider: name, id: model.id })),
      });
    }),
    refresh: vi.fn(),
    getAll: vi.fn(() =>
      Array.from(registeredProviders.entries()).flatMap(([, provider]) => provider.models),
    ),
    registeredProviders,
  } as any;
}

interface FakeGlobalSettings {
  customProviders?: CustomProvider[];
}

function makeStore(initialCustomProviders?: CustomProvider[]) {
  let settings: FakeGlobalSettings = { customProviders: initialCustomProviders };
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    getGlobalSettingsStore: () => ({
      getSettings: async () => settings,
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
      return undefined as never;
    }),
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const current = listeners.get(event) ?? [];
      listeners.set(event, current.filter((item) => item !== listener));
      return undefined as never;
    }),
    // Test-only helper: emits settings:updated the way TaskStore does.
    __emitSettingsUpdated(next: FakeGlobalSettings) {
      const previous = settings;
      settings = next;
      for (const listener of listeners.get("settings:updated") ?? []) {
        listener({ settings: next, previous });
      }
    },
  };
}

const customProvider = (overrides: Partial<CustomProvider> = {}): CustomProvider => ({
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "Acme AI",
  apiType: "openai-compatible",
  baseUrl: "https://acme.test/v1",
  apiKey: "ACME_KEY",
  models: [{ id: "acme-1", name: "Acme Model 1" }],
  ...overrides,
});

describe("seedDashboardProviders", () => {
  it("registers built-in API-key providers even with no custom providers (undefined)", async () => {
    const store = makeStore(undefined);
    const authStorage = makeAuthStorage();
    const modelRegistry = makeModelRegistry();

    const { authStorage: wrapped } = await seedDashboardProviders({ store, authStorage, modelRegistry });

    const providerIds = wrapped.getApiKeyProviders().map((p) => p.id);
    expect(providerIds).toEqual(expect.arrayContaining(["zai", "openrouter", "kimi-coding", "grok-cli"]));
  });

  it("registers built-in API-key providers with an empty customProviders array", async () => {
    const store = makeStore([]);
    const authStorage = makeAuthStorage();
    const modelRegistry = makeModelRegistry();

    const { authStorage: wrapped } = await seedDashboardProviders({ store, authStorage, modelRegistry });

    const providerIds = wrapped.getApiKeyProviders().map((p) => p.id);
    expect(providerIds).toEqual(expect.arrayContaining(["zai", "openrouter", "kimi-coding", "grok-cli"]));
  });

  it("keeps native Kimi K3 available through the installed pi model registry", async () => {
    // FNXC:ModelCatalog 2026-07-16-19:05: FN-8180 requires catalog coverage to
    // exercise pi's real 0.81.1 built-in registry, not a hand-written Kimi fixture.
    const modelRegistry = await createInMemoryModelRegistry();
    await modelRegistry.refresh();

    expect(modelRegistry.find("kimi-coding", "k3")).toMatchObject({
      provider: "kimi-coding",
      id: "k3",
      name: "Kimi K3",
      api: "anthropic-messages",
      baseUrl: "https://api.kimi.com/coding",
      contextWindow: 1_048_576,
      maxTokens: 131_072,
    });
  });

  it("registers one custom provider alongside built-ins", async () => {
    const store = makeStore([customProvider()]);
    const authStorage = makeAuthStorage();
    const modelRegistry = makeModelRegistry();

    const { authStorage: wrapped } = await seedDashboardProviders({ store, authStorage, modelRegistry });

    expect(modelRegistry.registerProvider).toHaveBeenCalledWith(
      "acme-ai",
      expect.objectContaining({ baseUrl: "https://acme.test/v1" }),
    );
    const providerIds = wrapped.getApiKeyProviders().map((p) => p.id);
    expect(providerIds).toEqual(expect.arrayContaining(["zai", "openrouter", "kimi-coding", "acme-ai"]));
  });

  it("registers multiple custom providers alongside built-ins", async () => {
    const store = makeStore([
      customProvider({ id: "id-1", name: "Acme One", baseUrl: "https://one.test" }),
      customProvider({ id: "id-2", name: "Acme Two", baseUrl: "https://two.test" }),
    ]);
    const authStorage = makeAuthStorage();
    const modelRegistry = makeModelRegistry();

    const { authStorage: wrapped } = await seedDashboardProviders({ store, authStorage, modelRegistry });

    const providerIds = wrapped.getApiKeyProviders().map((p) => p.id);
    expect(providerIds).toEqual(expect.arrayContaining(["zai", "openrouter", "acme-one", "acme-two"]));
  });

  it("registers an anthropic-compatible custom provider under the anthropic-messages api key (FN-7690)", async () => {
    const store = makeStore([
      customProvider({
        id: "anthropic-id",
        name: "Anthropic Custom",
        apiType: "anthropic-compatible",
        baseUrl: "https://anthropic.test",
      }),
    ]);
    const authStorage = makeAuthStorage();
    const modelRegistry = makeModelRegistry();

    await seedDashboardProviders({ store, authStorage, modelRegistry });

    expect(modelRegistry.registerProvider).toHaveBeenCalledWith(
      "anthropic-custom",
      expect.objectContaining({ api: "anthropic-messages" }),
    );
  });

  it("does not abort startup when reading custom providers from global settings fails", async () => {
    const authStorage = makeAuthStorage();
    const modelRegistry = makeModelRegistry();
    const log = vi.fn();
    const store = {
      getGlobalSettingsStore: () => ({
        getSettings: async () => {
          throw new Error("disk read failed");
        },
      }),
      on: vi.fn(),
      off: vi.fn(),
    };

    const { authStorage: wrapped } = await seedDashboardProviders({ store, authStorage, modelRegistry, log });

    // Built-ins still registered despite the custom-provider load failure.
    const providerIds = wrapped.getApiKeyProviders().map((p) => p.id);
    expect(providerIds).toEqual(expect.arrayContaining(["zai", "openrouter"]));
    expect(log).toHaveBeenCalledWith("custom-providers", expect.stringContaining("disk read failed"));
  });

  it("re-registers custom providers on settings:updated and dispose() unsubscribes", async () => {
    const store = makeStore([]);
    const authStorage = makeAuthStorage();
    const modelRegistry = makeModelRegistry();

    const { dispose } = await seedDashboardProviders({ store, authStorage, modelRegistry });

    expect(store.on).toHaveBeenCalledWith("settings:updated", expect.any(Function));
    modelRegistry.registerProvider.mockClear();

    store.__emitSettingsUpdated({ customProviders: [customProvider()] });
    expect(modelRegistry.registerProvider).toHaveBeenCalledWith(
      "acme-ai",
      expect.objectContaining({ baseUrl: "https://acme.test/v1" }),
    );

    dispose();
    expect(store.off).toHaveBeenCalledWith("settings:updated", expect.any(Function));

    modelRegistry.registerProvider.mockClear();
    store.__emitSettingsUpdated({ customProviders: [customProvider({ id: "id-2", name: "Second" })] });
    expect(modelRegistry.registerProvider).not.toHaveBeenCalled();
  });
});

/*
FNXC:ProviderAuth 2026-07-08-00:00:
FN-7689 regression coverage — registration path A (custom-provider-registry.ts `toProviderConfig`,
driven here via `registerCustomProviders`). Asserts the invariant: an opted-in openai-compatible
custom provider's registered pi-ai model config carries `compat.cacheControlFormat === "anthropic"`,
and that an opted-out (default) provider does NOT get it forced — no cache_control markers on
gateways that never asked for them (avoids provider 400s on backends like Together/Fireworks).
*/
describe("registerCustomProviders anthropicPromptCaching opt-in (FN-7689)", () => {
  it("sets compat.cacheControlFormat='anthropic' for an opted-in openai-compatible provider", () => {
    const modelRegistry = makeModelRegistry();
    const provider = customProvider({ anthropicPromptCaching: true });

    registerCustomProviders(modelRegistry, [provider], vi.fn());

    expect(modelRegistry.registerProvider).toHaveBeenCalledWith(
      "acme-ai",
      expect.objectContaining({
        api: "openai-completions",
        models: [expect.objectContaining({ compat: expect.objectContaining({ cacheControlFormat: "anthropic" }) })],
      }),
    );
  });

  it("does NOT set cacheControlFormat for an opted-out (default) openai-compatible provider", () => {
    const modelRegistry = makeModelRegistry();
    const provider = customProvider();

    registerCustomProviders(modelRegistry, [provider], vi.fn());

    const call = modelRegistry.registerProvider.mock.calls.find(([key]: [string]) => key === "acme-ai");
    expect(call).toBeDefined();
    const [, config] = call as [string, { models: Array<{ compat?: Record<string, unknown> }> }];
    expect(config.models[0].compat).not.toHaveProperty("cacheControlFormat");
  });

  it("leaves the opt-in inert for anthropic-compatible providers (already auto-caches)", () => {
    const modelRegistry = makeModelRegistry();
    const provider = customProvider({ apiType: "anthropic-compatible", anthropicPromptCaching: true });

    registerCustomProviders(modelRegistry, [provider], vi.fn());

    const call = modelRegistry.registerProvider.mock.calls.find(([key]: [string]) => key === "acme-ai");
    expect(call).toBeDefined();
    const [, config] = call as [string, { api: string; models: Array<{ compat?: Record<string, unknown> }> }];
    // FNXC:ProviderAuth 2026-07-08-17:50: anthropic-compatible resolves to the
    // registered pi-ai key "anthropic-messages" (FN-7690), not the bare
    // "anthropic" key which is never registered and throws at stream time.
    // Reconciles FN-7689's stale pre-FN-7690 expectation.
    expect(config.api).toBe("anthropic-messages");
    expect(config.models[0].compat).toBeUndefined();
  });

  it("leaves the opt-in inert for openai-responses providers (no cache_control concept there)", () => {
    const modelRegistry = makeModelRegistry();
    const provider = customProvider({ apiType: "openai-responses", anthropicPromptCaching: true });

    registerCustomProviders(modelRegistry, [provider], vi.fn());

    const call = modelRegistry.registerProvider.mock.calls.find(([key]: [string]) => key === "acme-ai");
    expect(call).toBeDefined();
    const [, config] = call as [string, { api: string; models: Array<{ compat?: Record<string, unknown> }> }];
    expect(config.api).toBe("openai-responses");
    expect(config.models[0].compat).toBeUndefined();
  });
});

/*
FNXC:ProviderAuth 2026-07-08-00:00:
FN-7689 symptom-based acceptance. The ORIGINAL SYMPTOM: a custom openai-compatible gateway proxying
Anthropic (e.g. usai/claude_4_6_sonnet) got cachedTokens=0/cacheWriteTokens=0 across all 243 runs
because pi-ai's openai-completions request builder never attached `cache_control` — detectCompat()
only auto-enables it for OpenRouter anthropic/* models. This drives the REAL pi-ai request-building
code path (not a reimplementation): register a provider through this module's own
`registerCustomProviders` (path A) into a real pi-ai ModelRegistry, resolve the model, then call
pi-ai's `completeSimple` (compat.ts, which internally calls the same `stream()` → `buildParams()` →
`getCompat()` → `getCompatCacheControl()` → `applyAnthropicCacheControl()` chain grounded during
preflight) with a system prompt, multi-turn messages, and a tool list. The mocked `fetch` seam
captures the exact HTTP request body pi-ai sends, so the assertion proves cache_control markers are
present on the wire where before this fix they were completely absent. Reverting Step 1 makes this
test fail (cache_control undefined everywhere).
*/
describe("FN-7689 symptom verification: cache_control on the wire for opted-in custom providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits cache_control on the system message, last conversation message, and last tool", async () => {
    const modelRegistry = await createInMemoryModelRegistry();

    const provider = customProvider({
      id: "aa0e8400-e29b-41d4-a716-446655440099",
      name: "Usai Gateway",
      baseUrl: "https://usai.example.test/v1",
      anthropicPromptCaching: true,
      models: [{ id: "claude_4_6_sonnet", name: "Claude 4.6 Sonnet" }],
    });
    registerCustomProviders(modelRegistry as any, [provider], vi.fn());

    const registryKey = customProviderRegistryKey(provider, [provider]);
    const model = modelRegistry.find(registryKey, "claude_4_6_sonnet");
    expect(model).toBeDefined();
    expect(model?.compat).toEqual(expect.objectContaining({ cacheControlFormat: "anthropic" }));

    let capturedBody: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: string }) => {
      capturedBody = init?.body ? JSON.parse(init.body) : undefined;
      return new Response(
        "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));

    await completeSimple(model!, {
      systemPrompt: "You are a helpful coding agent. Follow AGENTS.md conventions.",
      messages: [
        { role: "user", content: "Read this file and summarize it.", timestamp: Date.now() },
        {
          role: "assistant",
          content: [{ type: "text", text: "Here is a summary of the file." }],
          api: "openai-completions",
          provider: registryKey as any,
          model: "claude_4_6_sonnet",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        },
        { role: "user", content: "Now make the requested change.", timestamp: Date.now() },
      ],
      tools: [{ name: "read_file", description: "Read a file from disk", parameters: { type: "object", properties: {}, required: [] } as any }],
    } as any, { apiKey: "test-key" } as any);

    expect(capturedBody).toBeDefined();
    const messages = capturedBody.messages as Array<{ role: string; content: unknown }>;

    // System message carries cache_control on its (converted) text content block.
    const systemMessage = messages.find((m) => m.role === "system" || m.role === "developer");
    expect(systemMessage).toBeDefined();
    const systemContent = systemMessage!.content;
    expect(Array.isArray(systemContent) ? systemContent : []).toEqual(
      expect.arrayContaining([expect.objectContaining({ cache_control: { type: "ephemeral" } })]),
    );

    // Last user/assistant conversation message carries cache_control.
    const lastConversationMessage = [...messages].reverse().find((m) => m.role === "user" || m.role === "assistant");
    expect(lastConversationMessage).toBeDefined();
    const lastContent = lastConversationMessage!.content;
    expect(Array.isArray(lastContent) ? lastContent : []).toEqual(
      expect.arrayContaining([expect.objectContaining({ cache_control: { type: "ephemeral" } })]),
    );

    // Last tool definition carries cache_control.
    const tools = capturedBody.tools as Array<{ cache_control?: unknown }> | undefined;
    expect(tools).toBeDefined();
    expect(tools![tools!.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("emits NO cache_control when the provider did not opt in (negative control)", async () => {
    const modelRegistry = await createInMemoryModelRegistry();

    const provider = customProvider({
      id: "bb0e8400-e29b-41d4-a716-446655440098",
      name: "No Caching Gateway",
      baseUrl: "https://nocache.example.test/v1",
      models: [{ id: "some-model", name: "Some Model" }],
    });
    registerCustomProviders(modelRegistry as any, [provider], vi.fn());

    const registryKey = customProviderRegistryKey(provider, [provider]);
    const model = modelRegistry.find(registryKey, "some-model");
    expect(model).toBeDefined();
    expect(model?.compat).not.toHaveProperty("cacheControlFormat");

    let capturedBody: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: string }) => {
      capturedBody = init?.body ? JSON.parse(init.body) : undefined;
      return new Response(
        "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));

    await completeSimple(model!, {
      systemPrompt: "System prompt.",
      messages: [{ role: "user", content: "Hello.", timestamp: Date.now() }],
    } as any, { apiKey: "test-key" } as any);

    expect(capturedBody).toBeDefined();
    const messages = capturedBody.messages as Array<{ role: string; content: unknown }>;
    for (const message of messages) {
      if (Array.isArray(message.content)) {
        for (const part of message.content as Array<Record<string, unknown>>) {
          expect(part).not.toHaveProperty("cache_control");
        }
      }
    }
  });
});
