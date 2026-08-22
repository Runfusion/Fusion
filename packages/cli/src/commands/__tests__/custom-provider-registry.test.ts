import { describe, expect, it, vi } from "vitest";
import type { CustomProvider } from "@fusion/core";
import {
  registerCustomProviders,
  reregisterCustomProviders,
  resolveApiType,
} from "../custom-provider-registry.js";

/*
FNXC:CustomProviderModelWindows 2026-08-19-16:49:
RUFU-123: these tests now await the async register/reregister calls. Since the
bounded-refresh refactor (refreshFusionModelRegistry defers modelRegistry.refresh() to a
microtask), the synchronous `expect(refresh).toHaveBeenCalledTimes(1)` assertions failed
deterministically on main (observed pre-existing at ecb95a48e: 9/17 red); awaiting the
call restores the original assertion intent without weakening it.
*/
describe("custom-provider-registry", () => {
  it.each([
    ["openai-compatible", "openai-completions"],
    ["anthropic-compatible", "anthropic-messages"],
    ["openai-responses", "openai-responses"],
  ])("resolveApiType maps %s -> %s", (apiType, expectedApi) => {
    expect(resolveApiType(apiType)).toBe(expectedApi);
  });

  // FN-7690: resolveApiType() (this module) and resolveCustomProviderApiType()
  // (packages/engine/src/pi.ts, module-private) must agree on the pi-ai api key
  // for every apiType input, or the registration path and the streaming path
  // register/consume different (and possibly unregistered) api keys. pi.ts's
  // resolver is not importable here, so we pin resolveApiType's outputs against
  // the literal keys pi.ts is known (and tested) to return.
  it.each([
    ["openai-compatible", "openai-completions"],
    ["anthropic-compatible", "anthropic-messages"],
    ["openai-responses", "openai-responses"],
    ["unknown-type", "openai-completions"],
  ])("resolveApiType(%s) matches pi.ts resolveCustomProviderApiType's expected key (%s)", (apiType, expectedApi) => {
    expect(resolveApiType(apiType)).toBe(expectedApi);
  });

  it("registers providers with expected config shape", async () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();
    const logFn = vi.fn();
    const providers: CustomProvider[] = [
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "OpenAI Custom",
        apiType: "openai-compatible",
        baseUrl: "https://example.test/v1",
        apiKey: "CUSTOM_KEY",
        models: [{ id: "m1", name: "Model 1" }],
      },
      {
        id: "660e8400-e29b-41d4-a716-446655440001",
        name: "Anthropic Custom",
        apiType: "anthropic-compatible",
        baseUrl: "https://anthropic.test",
        apiKey: "ANTHROPIC_KEY",
        models: [{ id: "claude-x", name: "Claude X" }],
      },
    ];

    await registerCustomProviders({ registerProvider, refresh }, providers, logFn);

    expect(registerProvider).toHaveBeenNthCalledWith(1, "openai-custom", expect.objectContaining({
      baseUrl: "https://example.test/v1",
      api: "openai-completions",
      apiKey: "CUSTOM_KEY",
      models: [expect.objectContaining({ id: "m1", name: "Model 1", compat: { supportsDeveloperRole: false } })],
    }));
    expect(registerProvider).toHaveBeenNthCalledWith(2, "anthropic-custom", expect.objectContaining({
      baseUrl: "https://anthropic.test",
      api: "anthropic-messages",
      apiKey: "ANTHROPIC_KEY",
      models: [expect.objectContaining({ id: "claude-x", name: "Claude X" })],
    }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("uses slugified provider names and collision suffixes for registry keys", async () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    await registerCustomProviders(
      { registerProvider, refresh },
      [
        {
          id: "dd0e8400-e29b-41d4-a716-446655440008",
          name: "My AI Provider",
          apiType: "openai-compatible",
          baseUrl: "https://one.test",
        },
        {
          id: "ee0e8400-e29b-41d4-a716-446655440009",
          name: "My AI Provider",
          apiType: "openai-compatible",
          baseUrl: "https://two.test",
        },
      ],
      vi.fn(),
    );

    expect(registerProvider).toHaveBeenNthCalledWith(1, "my-ai-provider", expect.any(Object));
    expect(registerProvider).toHaveBeenNthCalledWith(2, "my-ai-provider-2", expect.any(Object));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("handles empty provider list and still refreshes", async () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    await registerCustomProviders({ registerProvider, refresh }, [], vi.fn());

    expect(registerProvider).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("uses empty models when models is missing", async () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    await registerCustomProviders(
      { registerProvider, refresh },
      [{
        id: "770e8400-e29b-41d4-a716-446655440002",
        name: "No Models",
        apiType: "openai-compatible",
        baseUrl: "https://nomodels.test",
      }],
      vi.fn(),
    );

    expect(registerProvider).toHaveBeenCalledWith("no-models", expect.objectContaining({ models: [] }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("continues when one provider registration fails", async () => {
    const registerProvider = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementationOnce(() => undefined);
    const refresh = vi.fn();
    const logFn = vi.fn();

    await registerCustomProviders(
      { registerProvider, refresh },
      [
        {
          id: "880e8400-e29b-41d4-a716-446655440003",
          name: "Bad",
          apiType: "openai-compatible",
          baseUrl: "https://bad.test",
        },
        {
          id: "990e8400-e29b-41d4-a716-446655440004",
          name: "Good",
          apiType: "openai-compatible",
          baseUrl: "https://good.test",
        },
      ],
      logFn,
    );

    expect(registerProvider).toHaveBeenCalledTimes(2);
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining("id=880e8400-e29b-41d4-a716-446655440003"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reregisters new providers", async () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    await reregisterCustomProviders(
      { registerProvider, refresh },
      [{ id: "aa0e8400-e29b-41d4-a716-446655440005", name: "Old", apiType: "openai-compatible", baseUrl: "https://old.test" }],
      [
        { id: "aa0e8400-e29b-41d4-a716-446655440005", name: "Old", apiType: "openai-compatible", baseUrl: "https://old.test" },
        { id: "bb0e8400-e29b-41d4-a716-446655440006", name: "New", apiType: "anthropic-compatible", baseUrl: "https://new.test" },
      ],
      vi.fn(),
    );

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith("new", expect.objectContaining({ api: "anthropic-messages" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("sets supportsDeveloperRole true only when opted in", async () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    await registerCustomProviders(
      { registerProvider, refresh },
      [
        { id: "optout", name: "Optout", apiType: "openai-compatible", baseUrl: "https://one.test", models: [{ id: "m", name: "M" }] },
        { id: "optin", name: "Optin", apiType: "openai-compatible", baseUrl: "https://two.test", supportsDeveloperRole: true, models: [{ id: "m", name: "M" }] },
        { id: "other", name: "Other", apiType: "anthropic-compatible", baseUrl: "https://three.test", models: [{ id: "m", name: "M" }] },
      ],
      vi.fn(),
    );

    expect(registerProvider).toHaveBeenNthCalledWith(1, "optout", expect.objectContaining({
      models: [expect.objectContaining({ compat: { supportsDeveloperRole: false } })],
    }));
    expect(registerProvider).toHaveBeenNthCalledWith(2, "optin", expect.objectContaining({
      models: [expect.objectContaining({ compat: { supportsDeveloperRole: true } })],
    }));
    const anthropicModels = registerProvider.mock.calls[2]?.[1]?.models as Array<Record<string, unknown>>;
    expect(anthropicModels[0]).not.toHaveProperty("compat");
  });

  it("reregisters changed providers", async () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    await reregisterCustomProviders(
      { registerProvider, refresh },
      [{ id: "cc0e8400-e29b-41d4-a716-446655440007", name: "Provider", apiType: "openai-compatible", baseUrl: "https://one.test", apiKey: "A" }],
      [{ id: "cc0e8400-e29b-41d4-a716-446655440007", name: "Provider", apiType: "openai-compatible", baseUrl: "https://two.test", apiKey: "B" }],
      vi.fn(),
    );

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith("provider", expect.objectContaining({
      baseUrl: "https://two.test",
      apiKey: "B",
    }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reregisters when only supportsDeveloperRole changes", async () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    await reregisterCustomProviders(
      { registerProvider, refresh },
      [{ id: "role", name: "Provider", apiType: "openai-compatible", baseUrl: "https://one.test", models: [{ id: "m", name: "M" }] }],
      [{ id: "role", name: "Provider", apiType: "openai-compatible", baseUrl: "https://one.test", supportsDeveloperRole: true, models: [{ id: "m", name: "M" }] }],
      vi.fn(),
    );

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith("provider", expect.objectContaining({
      models: [expect.objectContaining({ compat: { supportsDeveloperRole: true } })],
    }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("handles empty previous/current arrays", async () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    await reregisterCustomProviders({ registerProvider, refresh }, [], [], vi.fn());

    expect(registerProvider).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:CustomProviderModelWindows 2026-08-19-16:49:
  RUFU-123: per-model contextWindow/maxTokens must reach the registered provider config
  (unset models keep the 128000/16384 builder fallback), and a window-only settings edit
  must trip providersDiffer so the live settings:updated re-registration path picks it up.
  */
  it("carries per-model contextWindow/maxTokens into the registered config (RUFU-123)", async () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    await registerCustomProviders(
      { registerProvider, refresh },
      [
        {
          id: "f00e8400-e29b-41d4-a716-446655440010",
          name: "Windowed",
          apiType: "openai-compatible",
          baseUrl: "https://win.test",
          models: [
            { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 32768, maxTokens: 4096 },
            { id: "default-model", name: "Default" },
          ],
        },
      ],
      vi.fn(),
    );

    expect(registerProvider).toHaveBeenCalledWith("windowed", expect.objectContaining({
      models: [
        expect.objectContaining({ id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 32768, maxTokens: 4096 }),
        // Unset windows fall back to the builder defaults.
        expect.objectContaining({ id: "default-model", name: "Default", contextWindow: 128000, maxTokens: 16384 }),
      ],
    }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reregisters when only a model's contextWindow changes (RUFU-123 settings:updated path)", async () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    await reregisterCustomProviders(
      { registerProvider, refresh },
      [{ id: "g00e8400-e29b-41d4-a716-446655440011", name: "Provider", apiType: "openai-compatible", baseUrl: "https://one.test", models: [{ id: "m", name: "M" }] }],
      [{ id: "g00e8400-e29b-41d4-a716-446655440011", name: "Provider", apiType: "openai-compatible", baseUrl: "https://one.test", models: [{ id: "m", name: "M", contextWindow: 32768 }] }],
      vi.fn(),
    );

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith("provider", expect.objectContaining({
      models: [expect.objectContaining({ id: "m", name: "M", contextWindow: 32768, maxTokens: 16384 })],
    }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:CustomProviderThinkingFormat 2026-08-21-05:45:
  RUFU-143: the per-model thinking flags must reach the registered provider config and trip
  providersDiffer so the live settings:updated re-registration path picks up a flag edit. The
  provider name is deliberately NOT part of toProviderConfig, so a name-only rename must not
  false-positive into a re-registration (beyond the pre-existing behavior).
  */
  it("reregisters when a model's thinkingFormat is removed (RUFU-143 settings:updated path)", async () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    await reregisterCustomProviders(
      { registerProvider, refresh },
      [{ id: "h00e8400-e29b-41d4-a716-446655440012", name: "Provider", apiType: "openai-compatible", baseUrl: "https://one.test", models: [{ id: "m", name: "M", thinkingFormat: "qwen-chat-template" }] }],
      [{ id: "h00e8400-e29b-41d4-a716-446655440012", name: "Provider", apiType: "openai-compatible", baseUrl: "https://one.test", models: [{ id: "m", name: "M" }] }],
      vi.fn(),
    );

    expect(registerProvider).toHaveBeenCalledTimes(1);
    // The re-registered model's compat no longer carries the format (deep equality on compat).
    expect(registerProvider).toHaveBeenCalledWith("provider", expect.objectContaining({
      models: [expect.objectContaining({ id: "m", name: "M", compat: { supportsDeveloperRole: false } })],
    }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reregisters when a model opts out of thinking via reasoning: false (RUFU-143)", async () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    await reregisterCustomProviders(
      { registerProvider, refresh },
      [{ id: "i00e8400-e29b-41d4-a716-446655440013", name: "Provider", apiType: "openai-compatible", baseUrl: "https://one.test", models: [{ id: "m", name: "M" }] }],
      [{ id: "i00e8400-e29b-41d4-a716-446655440013", name: "Provider", apiType: "openai-compatible", baseUrl: "https://one.test", models: [{ id: "m", name: "M", reasoning: false }] }],
      vi.fn(),
    );

    expect(registerProvider).toHaveBeenCalledTimes(1);
    const models = registerProvider.mock.calls[0]?.[1]?.models as Array<Record<string, unknown>>;
    expect(models[0]).toMatchObject({ id: "m", reasoning: false });
    expect(models[0]).not.toHaveProperty("thinkingLevelMap");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not reregister when only an unrelated field (name) changes (RUFU-143 no false positive)", async () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    await reregisterCustomProviders(
      { registerProvider, refresh },
      [{ id: "j00e8400-e29b-41d4-a716-446655440014", name: "Provider A", apiType: "openai-compatible", baseUrl: "https://one.test", models: [{ id: "m", name: "M", thinkingFormat: "qwen-chat-template" }] }],
      [{ id: "j00e8400-e29b-41d4-a716-446655440014", name: "Provider B", apiType: "openai-compatible", baseUrl: "https://one.test", models: [{ id: "m", name: "M", thinkingFormat: "qwen-chat-template" }] }],
      vi.fn(),
    );

    expect(registerProvider).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
