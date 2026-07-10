import { describe, expect, it, vi } from "vitest";
import type { CustomProvider } from "@fusion/core";
import {
  registerCustomProviders,
  reregisterCustomProviders,
  resolveApiType,
} from "../custom-provider-registry.js";

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

  it("registers providers with expected config shape", () => {
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

    registerCustomProviders({ registerProvider, refresh }, providers, logFn);

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

  it("uses slugified provider names and collision suffixes for registry keys", () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    registerCustomProviders(
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

  it("handles empty provider list and still refreshes", () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    registerCustomProviders({ registerProvider, refresh }, [], vi.fn());

    expect(registerProvider).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("uses empty models when models is missing", () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    registerCustomProviders(
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

  it("continues when one provider registration fails", () => {
    const registerProvider = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementationOnce(() => undefined);
    const refresh = vi.fn();
    const logFn = vi.fn();

    registerCustomProviders(
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

  it("reregisters new providers", () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    reregisterCustomProviders(
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

  it("sets supportsDeveloperRole true only when opted in", () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    registerCustomProviders(
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

  it("reregisters changed providers", () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    reregisterCustomProviders(
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

  it("reregisters when only supportsDeveloperRole changes", () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    reregisterCustomProviders(
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

  it("handles empty previous/current arrays", () => {
    const registerProvider = vi.fn();
    const refresh = vi.fn();

    reregisterCustomProviders({ registerProvider, refresh }, [], [], vi.fn());

    expect(registerProvider).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
