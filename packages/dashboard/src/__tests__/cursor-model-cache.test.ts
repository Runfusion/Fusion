import { afterEach, describe, expect, it, vi } from "vitest";
import type { CursorModelDiscoveryResult } from "../runtime-provider-probes.js";

vi.mock("../runtime-provider-probes.js", () => ({
  discoverCursorCliModels: vi.fn(),
}));

import { discoverCursorCliModels } from "../runtime-provider-probes.js";
import {
  __resetCursorPickerModelsCacheForTests,
  cursorDiscoveryToModels,
  getCursorPickerModels,
} from "../cursor-model-cache.js";

const mockedDiscover = vi.mocked(discoverCursorCliModels);

afterEach(() => {
  vi.clearAllMocks();
  __resetCursorPickerModelsCacheForTests();
});

describe("cursorDiscoveryToModels", () => {
  it("maps a discovered model with a label", () => {
    const models = cursorDiscoveryToModels([{ id: "cursor/gpt-5", label: "GPT-5" }]);
    expect(models).toEqual([
      { provider: "cursor-cli", id: "cursor/gpt-5", name: "GPT-5", reasoning: false, contextWindow: 0 },
    ]);
  });

  it("falls back to the id as the name when no label is provided", () => {
    const models = cursorDiscoveryToModels([{ id: "cursor/sonnet" }]);
    expect(models).toEqual([
      { provider: "cursor-cli", id: "cursor/sonnet", name: "cursor/sonnet", reasoning: false, contextWindow: 0 },
    ]);
  });

  it("maps multiple models preserving order", () => {
    const models = cursorDiscoveryToModels([{ id: "cursor/gpt-5" }, { id: "cursor/sonnet" }]);
    expect(models.map((m) => m.id)).toEqual(["cursor/gpt-5", "cursor/sonnet"]);
  });

  it("de-duplicates entries that map to the same stable id, keeping the first occurrence", () => {
    const models = cursorDiscoveryToModels([
      { id: "cursor/gpt-5", label: "First" },
      { id: "cursor/gpt-5", label: "Second" },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("First");
  });

  it("returns an empty array for an empty model list", () => {
    expect(cursorDiscoveryToModels([])).toEqual([]);
  });

  it("surfaces source-reported reasoning/contextWindow metadata when present", () => {
    const models = cursorDiscoveryToModels([
      { id: "cursor/gpt-5", label: "GPT-5", reasoning: true, contextWindow: 200000 },
    ]);
    expect(models).toEqual([
      { provider: "cursor-cli", id: "cursor/gpt-5", name: "GPT-5", reasoning: true, contextWindow: 200000 },
    ]);
  });

  it("defaults reasoning/contextWindow to false/0 when the entry does not report them", () => {
    const models = cursorDiscoveryToModels([{ id: "cursor/sonnet" }]);
    expect(models[0]?.reasoning).toBe(false);
    expect(models[0]?.contextWindow).toBe(0);
  });

  it("handles a mix of enriched and default entries independently", () => {
    const models = cursorDiscoveryToModels([
      { id: "cursor/a", reasoning: true, contextWindow: 128000 },
      { id: "cursor/b" },
    ]);
    expect(models).toEqual([
      { provider: "cursor-cli", id: "cursor/a", name: "cursor/a", reasoning: true, contextWindow: 128000 },
      { provider: "cursor-cli", id: "cursor/b", name: "cursor/b", reasoning: false, contextWindow: 0 },
    ]);
  });
});

describe("getCursorPickerModels caching", () => {
  it("fetches once and returns mapped models", async () => {
    mockedDiscover.mockResolvedValue({
      models: [{ id: "cursor/gpt-5", label: "GPT-5" }],
      source: "json",
      fallbackUsed: false,
    });

    const models = await getCursorPickerModels({ binaryPath: "cursor-test-1" });

    expect(models).toEqual([
      { provider: "cursor-cli", id: "cursor/gpt-5", name: "GPT-5", reasoning: false, contextWindow: 0 },
    ]);
    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("serves subsequent requests within the TTL window from cache with no additional spawn", async () => {
    mockedDiscover.mockResolvedValue({ models: [{ id: "cursor/sonnet" }], source: "json", fallbackUsed: false });
    let clock = 1000;
    const now = () => clock;

    await getCursorPickerModels({ binaryPath: "cursor-test-2", ttlMs: 60_000, now });
    clock += 30_000; // still inside the 60s TTL
    await getCursorPickerModels({ binaryPath: "cursor-test-2", ttlMs: 60_000, now });

    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("refreshes after the TTL window expires", async () => {
    mockedDiscover.mockResolvedValue({ models: [{ id: "cursor/sonnet" }], source: "json", fallbackUsed: false });
    let clock = 1000;
    const now = () => clock;

    await getCursorPickerModels({ binaryPath: "cursor-test-3", ttlMs: 1_000, now });
    clock += 1_001; // past the 1s TTL
    await getCursorPickerModels({ binaryPath: "cursor-test-3", ttlMs: 1_000, now });

    expect(mockedDiscover).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent requests for the same binaryPath", async () => {
    let resolveFetch: (v: CursorModelDiscoveryResult) => void = () => {};
    mockedDiscover.mockImplementation(
      () =>
        new Promise<CursorModelDiscoveryResult>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const p1 = getCursorPickerModels({ binaryPath: "cursor-test-4" });
    const p2 = getCursorPickerModels({ binaryPath: "cursor-test-4" });

    resolveFetch({ models: [{ id: "cursor/sonnet" }], source: "json", fallbackUsed: false });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual(r2);
    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("degrades to an empty array (never throws) when the CLI fetch rejects, and caches the empty result", async () => {
    mockedDiscover.mockRejectedValue(new Error("cursor-agent models --json failed: binary not found"));
    let clock = 1000;
    const now = () => clock;

    const first = await getCursorPickerModels({ binaryPath: "cursor-test-5", ttlMs: 60_000, now });
    expect(first).toEqual([]);

    clock += 10; // still inside TTL
    const second = await getCursorPickerModels({ binaryPath: "cursor-test-5", ttlMs: 60_000, now });
    expect(second).toEqual([]);

    // The failure result is cached too — only one spawn attempt within the TTL window.
    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("degrades to an empty array when discovery reports the binary unavailable (fallbackUsed, empty models)", async () => {
    mockedDiscover.mockResolvedValue({
      models: [],
      source: "probe",
      fallbackUsed: true,
      reason: "binary unavailable",
    });

    const models = await getCursorPickerModels({ binaryPath: "cursor-test-6" });
    expect(models).toEqual([]);
  });

  it("defaults binaryPath to cursor-agent when not explicitly provided", async () => {
    mockedDiscover.mockResolvedValue({ models: [], source: "probe", fallbackUsed: true });

    await getCursorPickerModels();
    expect(mockedDiscover).toHaveBeenCalledWith({ binaryPath: "cursor-agent" });
  });

  it("caches distinct binaryPaths independently", async () => {
    mockedDiscover.mockResolvedValue({ models: [{ id: "cursor/sonnet" }], source: "json", fallbackUsed: false });

    await getCursorPickerModels({ binaryPath: "cursor-test-7a" });
    await getCursorPickerModels({ binaryPath: "cursor-test-7b" });

    expect(mockedDiscover).toHaveBeenCalledTimes(2);
  });

  // FN-7710: a transient cold-start empty/unavailable result must not poison
  // the cache for the full 60s TTL — it self-heals after a much shorter
  // negative-TTL window while a non-empty result keeps the normal TTL.
  it("re-fetches an empty/unavailable result well before the full 60s TTL elapses", async () => {
    mockedDiscover.mockResolvedValueOnce({ models: [], source: "probe", fallbackUsed: true, reason: "binary unavailable" });
    let clock = 1000;
    const now = () => clock;

    const first = await getCursorPickerModels({ binaryPath: "cursor-test-8", ttlMs: 60_000, now });
    expect(first).toEqual([]);

    // Well past a short negative-TTL window, but far short of the full 60s TTL.
    clock += 10_000;
    mockedDiscover.mockResolvedValueOnce({ models: [{ id: "cursor/sonnet" }], source: "json", fallbackUsed: false });
    const second = await getCursorPickerModels({ binaryPath: "cursor-test-8", ttlMs: 60_000, now });

    expect(second).toEqual([
      { provider: "cursor-cli", id: "cursor/sonnet", name: "cursor/sonnet", reasoning: false, contextWindow: 0 },
    ]);
    expect(mockedDiscover).toHaveBeenCalledTimes(2);
  });

  it("keeps a successful non-empty result cached for the full requested TTL (unlike an empty result)", async () => {
    mockedDiscover.mockResolvedValueOnce({ models: [{ id: "cursor/sonnet" }], source: "json", fallbackUsed: false });
    let clock = 1000;
    const now = () => clock;

    await getCursorPickerModels({ binaryPath: "cursor-test-9", ttlMs: 60_000, now });
    clock += 10_000; // inside the 60s TTL for a non-empty result
    await getCursorPickerModels({ binaryPath: "cursor-test-9", ttlMs: 60_000, now });

    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });
});
