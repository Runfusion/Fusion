/*
FNXC:ModelCatalog 2026-07-07-09:10:
FN-7636 regression coverage: Hermes-configured models (`hermes profile list`,
mocked at the `../runtime-provider-probes.js` boundary) must appear
additively under provider "hermes" in `/api/models`, deduped by provider/id
with existing rows always winning collisions, never displacing/filtering out
unrelated rows, and degrading to zero Hermes rows (HTTP 200, existing rows
intact) when the underlying façade throws. Also covers the caching
contract (single spawn per request cycle) and the configuredProviders
allow-list interaction ("hermes" only added when rows were contributed).
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

vi.mock("../runtime-provider-probes.js", () => ({
  listHermesProviderProfiles: vi.fn(),
}));

import { listHermesProviderProfiles } from "../runtime-provider-probes.js";
import { registerModelRoutes } from "../routes/register-model-routes.js";
import { __resetHermesPickerModelsCacheForTests } from "../hermes-model-cache.js";

const mockedList = vi.mocked(listHermesProviderProfiles);

afterEach(() => {
  vi.clearAllMocks();
  __resetHermesPickerModelsCacheForTests();
});

function setup(availableModels: Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number }>) {
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
    // FNXC:ModelCatalog 2026-08-23-23:12: registerModelRoutes also registers POST /models/refresh (FN-019 operator catalog refresh), so a router fake exposing only `get` throws before any GET handler is captured.
    post: vi.fn(),
  } as unknown as Router;

  const store = {
    getGlobalSettingsStore: () => ({
      getSettings: vi.fn().mockResolvedValue({ useDroidCli: true }),
    }),
    getSettingsFast: vi.fn().mockResolvedValue({}),
  };

  const runtimeLogger = {
    child: vi.fn(() => ({ warn: vi.fn() })),
  };

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

  return { handler: getHandlers.get("/models")! };
}

async function callModels(handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) {
  const json = vi.fn();
  await handler({}, { json });
  return json.mock.calls[0][0] as { models: Array<{ provider: string; id: string; name: string }> };
}

// Use a droid-cli row (with useDroidCli:true in settings) as the "existing
// row that must survive" baseline: unlike "openai", its presence in the
// final response does not depend on the test runner's ambient auth-storage
// files (~/.fusion/agent/auth.json etc.), which vary across environments.
const OPENAI_MODEL = { provider: "droid-cli", id: "droid/model", name: "Droid", reasoning: false, contextWindow: 0 };

/*
FNXC:ModelThinkingCapabilities 2026-08-23-23:20:
FN-021 added a derived `supportedThinkingLevels` to every catalog row emitted by the registry map in /api/models; a non-reasoning row derives ["off"]. Rows Hermes appends after that map carry no such field, so only registry-sourced rows change shape here.
*/
const EXPECTED_DROID_ROW = { ...OPENAI_MODEL, supportedThinkingLevels: ["off"] };

describe("register-model-routes: Hermes additive surfacing", () => {
  it("adds zero Hermes rows and leaves existing rows unchanged when no profiles are configured", async () => {
    mockedList.mockResolvedValue([]);
    const { handler } = setup([OPENAI_MODEL]);

    const response = await callModels(handler);

    expect(response.models).toEqual([EXPECTED_DROID_ROW]);
    expect(response.models.some((m) => m.provider === "hermes")).toBe(false);
  });

  it("surfaces a single profile with a model, mapped to a hermes/<name> row, alongside existing rows", async () => {
    mockedList.mockResolvedValue([{ name: "default", model: "MiniMax-M3", isDefault: true }]);
    const { handler } = setup([OPENAI_MODEL]);

    const response = await callModels(handler);

    expect(response.models).toContainEqual(EXPECTED_DROID_ROW);
    expect(response.models).toContainEqual({
      provider: "hermes",
      id: "default",
      name: "default (MiniMax-M3)",
      reasoning: false,
      contextWindow: 0,
    });
  });

  it("surfaces a profile without a model using the profile name only", async () => {
    mockedList.mockResolvedValue([{ name: "bare-profile", isDefault: false }]);
    const { handler } = setup([]);

    const response = await callModels(handler);

    expect(response.models).toContainEqual({
      provider: "hermes",
      id: "bare-profile",
      name: "bare-profile",
      reasoning: false,
      contextWindow: 0,
    });
  });

  it("surfaces multiple profiles as multiple rows without dropping existing rows", async () => {
    mockedList.mockResolvedValue([
      { name: "default", model: "MiniMax-M3", isDefault: true },
      { name: "work", model: "claude-sonnet-4-5", isDefault: false },
    ]);
    const { handler } = setup([OPENAI_MODEL]);

    const response = await callModels(handler);

    expect(response.models.some((m) => m.provider === "droid-cli")).toBe(true);
    expect(response.models.filter((m) => m.provider === "hermes")).toHaveLength(2);
  });

  it("keeps the existing row when a Hermes-derived id collides with an already-present row (existing row wins)", async () => {
    const existingHermesRow = { provider: "hermes", id: "default", name: "Pre-existing Hermes Row", reasoning: true, contextWindow: 999 };
    mockedList.mockResolvedValue([{ name: "default", model: "MiniMax-M3", isDefault: true }]);
    const { handler } = setup([OPENAI_MODEL, existingHermesRow]);

    const response = await callModels(handler);

    const hermesRows = response.models.filter((m) => m.provider === "hermes" && m.id === "default");
    expect(hermesRows).toHaveLength(1);
    expect(hermesRows[0]).toEqual(existingHermesRow);
  });

  it("degrades to zero Hermes rows and returns HTTP 200 with existing rows intact when the façade throws", async () => {
    mockedList.mockRejectedValue(new Error("hermes profile list failed: binary not found"));
    const { handler } = setup([OPENAI_MODEL]);

    const response = await callModels(handler);

    expect(response.models).toEqual([EXPECTED_DROID_ROW]);
    expect(response.models.some((m) => m.provider === "hermes")).toBe(false);
  });

  it("does not include hermes in configuredProviders (and thus contributes no rows) when zero profiles exist", async () => {
    mockedList.mockResolvedValue([]);
    const { handler } = setup([{ provider: "hermes", id: "unconfigured-registry-row", name: "Should be filtered", reasoning: false, contextWindow: 0 }]);

    const response = await callModels(handler);

    // A hermes-provider row surfaced solely via modelRegistry.getAvailable()
    // (not via the Hermes profile façade) is still subject to the
    // configuredProviders allow-list: with zero Hermes profiles configured,
    // "hermes" is never added to the allow-list, so this row is filtered.
    expect(response.models.some((m) => m.provider === "hermes")).toBe(false);
  });

  it("calls the Hermes façade at most once per /api/models request (single-flight cache boundary honored)", async () => {
    mockedList.mockResolvedValue([{ name: "default", isDefault: true }]);
    const { handler } = setup([OPENAI_MODEL]);

    await callModels(handler);

    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it("serves a second request within the cache TTL without spawning again", async () => {
    mockedList.mockResolvedValue([{ name: "default", isDefault: true }]);
    const { handler } = setup([OPENAI_MODEL]);

    await callModels(handler);
    await callModels(handler);

    // Both requests hit register-model-routes' default (unconfigured ttl ->
    // module default ~60s) cache window, so only the first should spawn.
    expect(mockedList).toHaveBeenCalledTimes(1);
  });
});
