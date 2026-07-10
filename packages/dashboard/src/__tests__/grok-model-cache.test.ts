import { afterEach, describe, expect, it, vi } from "vitest";
import type { GrokModelDiscoveryResult } from "../runtime-provider-probes.js";

vi.mock("../runtime-provider-probes.js", () => ({
  discoverGrokCliModels: vi.fn(),
}));

import { discoverGrokCliModels } from "../runtime-provider-probes.js";
import {
  __resetGrokPickerModelsCacheForTests,
  grokDiscoveryToModels,
  getGrokPickerModels,
} from "../grok-model-cache.js";

const mockedDiscover = vi.mocked(discoverGrokCliModels);

afterEach(() => {
  vi.clearAllMocks();
  __resetGrokPickerModelsCacheForTests();
});

describe("grokDiscoveryToModels", () => {
  it("maps a discovered model with a label", () => {
    const models = grokDiscoveryToModels([{ id: "grok-4", label: "Grok 4" }]);
    expect(models).toEqual([
      { provider: "grok-cli", id: "grok-4", name: "Grok 4", reasoning: false, contextWindow: 0 },
    ]);
  });

  it("falls back to the id as the name when no label is provided", () => {
    const models = grokDiscoveryToModels([{ id: "grok-4-fast" }]);
    expect(models).toEqual([
      { provider: "grok-cli", id: "grok-4-fast", name: "grok-4-fast", reasoning: false, contextWindow: 0 },
    ]);
  });

  it("de-duplicates entries that map to the same stable id, keeping the first occurrence", () => {
    const models = grokDiscoveryToModels([
      { id: "grok-4", label: "First" },
      { id: "grok-4", label: "Second" },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("First");
  });

  it("returns an empty array for an empty model list", () => {
    expect(grokDiscoveryToModels([])).toEqual([]);
  });
});

describe("getGrokPickerModels caching", () => {
  it("fetches once and returns mapped models", async () => {
    mockedDiscover.mockResolvedValue({
      models: [{ id: "grok-4", label: "Grok 4" }],
      source: "models-text",
      fallbackUsed: false,
    });

    const models = await getGrokPickerModels({ binaryPath: "grok-test-1" });

    expect(models).toEqual([
      { provider: "grok-cli", id: "grok-4", name: "Grok 4", reasoning: false, contextWindow: 0 },
    ]);
    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("serves subsequent requests within the TTL window from cache with no additional spawn", async () => {
    mockedDiscover.mockResolvedValue({ models: [{ id: "grok-4" }], source: "models-text", fallbackUsed: false });
    let clock = 1000;
    const now = () => clock;

    await getGrokPickerModels({ binaryPath: "grok-test-2", ttlMs: 60_000, now });
    clock += 30_000;
    await getGrokPickerModels({ binaryPath: "grok-test-2", ttlMs: 60_000, now });

    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("refreshes after the TTL window expires", async () => {
    mockedDiscover.mockResolvedValue({ models: [{ id: "grok-4" }], source: "models-text", fallbackUsed: false });
    let clock = 1000;
    const now = () => clock;

    await getGrokPickerModels({ binaryPath: "grok-test-3", ttlMs: 1_000, now });
    clock += 1_001;
    await getGrokPickerModels({ binaryPath: "grok-test-3", ttlMs: 1_000, now });

    expect(mockedDiscover).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent requests for the same binaryPath", async () => {
    let resolveFetch: (v: GrokModelDiscoveryResult) => void = () => {};
    mockedDiscover.mockImplementation(
      () =>
        new Promise<GrokModelDiscoveryResult>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const p1 = getGrokPickerModels({ binaryPath: "grok-test-4" });
    const p2 = getGrokPickerModels({ binaryPath: "grok-test-4" });

    resolveFetch({ models: [{ id: "grok-4" }], source: "models-text", fallbackUsed: false });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual(r2);
    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("degrades to an empty array (never throws) when the CLI fetch rejects, and caches the empty result", async () => {
    mockedDiscover.mockRejectedValue(new Error("grok models failed: binary not found"));
    let clock = 1000;
    const now = () => clock;

    const first = await getGrokPickerModels({ binaryPath: "grok-test-5", ttlMs: 60_000, now });
    expect(first).toEqual([]);

    clock += 10;
    const second = await getGrokPickerModels({ binaryPath: "grok-test-5", ttlMs: 60_000, now });
    expect(second).toEqual([]);

    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("degrades to an empty array when discovery reports the binary unavailable (fallbackUsed, empty models)", async () => {
    mockedDiscover.mockResolvedValue({
      models: [],
      source: "probe",
      fallbackUsed: true,
      reason: "binary unavailable",
    });

    const models = await getGrokPickerModels({ binaryPath: "grok-test-6" });
    expect(models).toEqual([]);
  });

  it("defaults binaryPath to grok when not explicitly provided", async () => {
    mockedDiscover.mockResolvedValue({ models: [], source: "probe", fallbackUsed: true });

    await getGrokPickerModels();
    expect(mockedDiscover).toHaveBeenCalledWith({ binaryPath: "grok" });
  });

  it("caches distinct binaryPaths independently", async () => {
    mockedDiscover.mockResolvedValue({ models: [{ id: "grok-4" }], source: "models-text", fallbackUsed: false });

    await getGrokPickerModels({ binaryPath: "grok-test-7a" });
    await getGrokPickerModels({ binaryPath: "grok-test-7b" });

    expect(mockedDiscover).toHaveBeenCalledTimes(2);
  });

  // FN-7710: mirrors the Cursor picker cache negative-TTL hardening — a transient
  // cold-start empty/unavailable result must not poison the cache for the full 60s TTL.
  it("re-fetches an empty/unavailable result well before the full 60s TTL elapses", async () => {
    mockedDiscover.mockResolvedValueOnce({ models: [], source: "probe", fallbackUsed: true, reason: "binary unavailable" });
    let clock = 1000;
    const now = () => clock;

    const first = await getGrokPickerModels({ binaryPath: "grok-test-8", ttlMs: 60_000, now });
    expect(first).toEqual([]);

    // Well past a short negative-TTL window, but far short of the full 60s TTL.
    clock += 10_000;
    mockedDiscover.mockResolvedValueOnce({ models: [{ id: "grok-4" }], source: "models-text", fallbackUsed: false });
    const second = await getGrokPickerModels({ binaryPath: "grok-test-8", ttlMs: 60_000, now });

    expect(second).toEqual([
      { provider: "grok-cli", id: "grok-4", name: "grok-4", reasoning: false, contextWindow: 0 },
    ]);
    expect(mockedDiscover).toHaveBeenCalledTimes(2);
  });

  it("keeps a successful non-empty result cached for the full requested TTL (unlike an empty result)", async () => {
    mockedDiscover.mockResolvedValueOnce({ models: [{ id: "grok-4" }], source: "models-text", fallbackUsed: false });
    let clock = 1000;
    const now = () => clock;

    await getGrokPickerModels({ binaryPath: "grok-test-9", ttlMs: 60_000, now });
    clock += 10_000; // inside the 60s TTL for a non-empty result
    await getGrokPickerModels({ binaryPath: "grok-test-9", ttlMs: 60_000, now });

    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });
});
