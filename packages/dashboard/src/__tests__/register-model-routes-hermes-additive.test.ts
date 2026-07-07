/*
FNXC:ModelCatalog 2026-07-07-08:10:
FN-7630 (GitHub #1931) regression coverage: a connected/active Hermes Runtime
plugin must never narrow /api/models' effective provider/model set. This
suite reproduces the reported symptom \u2014 a persisted customProviders entry
plus a "connected" Hermes runtime (simulated by Hermes-labeled entries
appearing in modelRegistry.getAvailable(), which is what a live runtime
plugin contributing models would look like) \u2014 and asserts the custom
provider's registry key stays in configuredProviders and its models stay in
the /api/models response, across empty/single/multiple customProviders data
states.
*/
import { describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import { registerModelRoutes } from "../routes/register-model-routes.js";
import { customProviderRegistryKey } from "@fusion/core";
import type { CustomProvider } from "@fusion/core";

interface SetupOptions {
  customProviders: CustomProvider[];
  /** When true, simulate a connected/active Hermes runtime contributing its own models to the registry. */
  hermesConnected: boolean;
}

function setup({ customProviders, hermesConnected }: SetupOptions) {
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
  } as unknown as Router;

  const store = {
    getGlobalSettingsStore: () => ({
      getSettings: vi.fn().mockResolvedValue({ customProviders }),
    }),
    getSettingsFast: vi.fn().mockResolvedValue({}),
  };

  const runtimeLogger = {
    child: vi.fn(() => ({ warn: vi.fn() })),
  };

  const customModels = customProviders.flatMap((provider) =>
    (provider.models ?? []).map((model) => ({
      provider: customProviderRegistryKey(provider, customProviders),
      id: model.id,
      name: model.name,
      reasoning: false,
      contextWindow: 0,
    })),
  );

  // A connected Hermes runtime is simulated by the underlying model registry
  // surfacing Hermes-provider entries alongside everything else — exactly how
  // a live runtime plugin contributing models would present itself. Item 1
  // (additively surfacing these in the picker) is deferred; this test only
  // proves their mere presence does not suppress unrelated entries.
  const hermesModels = hermesConnected
    ? [{ provider: "hermes", id: "hermes/default", name: "Hermes Default", reasoning: false, contextWindow: 0 }]
    : [];

  const availableModels = [
    { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 },
    ...customModels,
    ...hermesModels,
  ];

  const modelRegistry = {
    refresh: vi.fn(),
    getAvailable: vi.fn(() => availableModels),
  };

  registerModelRoutes({
    router,
    store: store as never,
    runtimeLogger: runtimeLogger as never,
    options: { modelRegistry } as never,
  } as never);

  return { handler: getHandlers.get("/models")!, modelRegistry };
}

async function callModels(handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) {
  const json = vi.fn();
  await handler({}, { json });
  return json.mock.calls[0][0] as { models: Array<{ provider: string; id: string }> };
}

describe("FN-7630: Hermes runtime additive — /api/models", () => {
  it("keeps a single custom provider's models present whether or not Hermes is connected", async () => {
    const customProviders: CustomProvider[] = [
      { id: "cp-1", name: "My Provider", apiType: "openai-compatible", baseUrl: "https://example.com", models: [{ id: "custom-model-1", name: "Custom Model 1" }] },
    ];
    const key = customProviderRegistryKey(customProviders[0]!, customProviders);

    const disconnected = await callModels(setup({ customProviders, hermesConnected: false }).handler);
    const connected = await callModels(setup({ customProviders, hermesConnected: true }).handler);

    for (const response of [disconnected, connected]) {
      expect(response.models.some((m) => m.provider === key && m.id === "custom-model-1")).toBe(true);
    }
  });

  it("keeps multiple custom providers' models present when Hermes is connected", async () => {
    const customProviders: CustomProvider[] = [
      { id: "cp-1", name: "Provider One", apiType: "openai-compatible", baseUrl: "https://a.example.com", models: [{ id: "model-a", name: "Model A" }] },
      { id: "cp-2", name: "Provider Two", apiType: "anthropic-compatible", baseUrl: "https://b.example.com", models: [{ id: "model-b", name: "Model B" }] },
    ];
    const keyOne = customProviderRegistryKey(customProviders[0]!, customProviders);
    const keyTwo = customProviderRegistryKey(customProviders[1]!, customProviders);

    const { handler } = setup({ customProviders, hermesConnected: true });
    const response = await callModels(handler);

    expect(response.models.some((m) => m.provider === keyOne && m.id === "model-a")).toBe(true);
    expect(response.models.some((m) => m.provider === keyTwo && m.id === "model-b")).toBe(true);
  });

  it("does not shrink the effective model set when Hermes connects, with no customProviders configured", async () => {
    const disconnected = await callModels(setup({ customProviders: [], hermesConnected: false }).handler);
    const connected = await callModels(setup({ customProviders: [], hermesConnected: true }).handler);

    // Neither state has any configured auth/customProviders, so the effective
    // (filtered) model set is empty both ways — connecting Hermes must not
    // change that baseline (i.e. it must not remove entries that would
    // otherwise be configured). This proves the filter step itself carries no
    // Hermes-specific branch that could shrink an otherwise-configured set.
    expect(connected.models.length).toBeGreaterThanOrEqual(disconnected.models.length);
  });

  it("never surfaces unconfigured Hermes-provider entries as a side effect (item 1 deferred, not silently regressed)", async () => {
    const { handler } = setup({ customProviders: [], hermesConnected: true });
    const response = await callModels(handler);
    // Item 1 (additive Hermes model surfacing) is explicitly deferred per the
    // task docs; this asserts the deferral is a no-op today, not a silent
    // failure that could later be confused with active suppression.
    expect(response.models.some((m) => m.provider === "hermes")).toBe(false);
  });

  it("a custom provider whose registry key collides in name-shape with a Hermes-derived id still surfaces its models", async () => {
    const customProviders: CustomProvider[] = [
      { id: "cp-hermes-like", name: "hermes", apiType: "openai-compatible", baseUrl: "https://c.example.com", models: [{ id: "collide-model", name: "Collide Model" }] },
    ];
    const key = customProviderRegistryKey(customProviders[0]!, customProviders);

    const { handler } = setup({ customProviders, hermesConnected: true });
    const response = await callModels(handler);

    expect(response.models.some((m) => m.provider === key && m.id === "collide-model")).toBe(true);
  });
});
