import { afterEach, describe, expect, it, vi } from "vitest";
import type { HermesProfileSummary } from "../runtime-provider-probes.js";

vi.mock("../runtime-provider-probes.js", () => ({
  listHermesProviderProfiles: vi.fn(),
}));

import { listHermesProviderProfiles } from "../runtime-provider-probes.js";
import {
  __resetHermesPickerModelsCacheForTests,
  getHermesPickerModels,
  hermesProfilesToModels,
} from "../hermes-model-cache.js";

const mockedList = vi.mocked(listHermesProviderProfiles);

afterEach(() => {
  vi.clearAllMocks();
  __resetHermesPickerModelsCacheForTests();
});

describe("hermesProfilesToModels", () => {
  it("maps a profile with a model into a labeled row using profile name as stable id", () => {
    const profiles: HermesProfileSummary[] = [
      { name: "default", model: "MiniMax-M3", gateway: "stopped", isDefault: true },
    ];
    const models = hermesProfilesToModels(profiles);
    expect(models).toEqual([
      { provider: "hermes", id: "default", name: "default (MiniMax-M3)", reasoning: false, contextWindow: 0 },
    ]);
  });

  it("maps a profile without a model to a name-only label", () => {
    const profiles: HermesProfileSummary[] = [{ name: "no-model-profile", isDefault: false }];
    const models = hermesProfilesToModels(profiles);
    expect(models).toEqual([
      { provider: "hermes", id: "no-model-profile", name: "no-model-profile", reasoning: false, contextWindow: 0 },
    ]);
  });

  it("maps multiple profiles preserving order", () => {
    const profiles: HermesProfileSummary[] = [
      { name: "default", model: "MiniMax-M3", isDefault: true },
      { name: "work", model: "claude-sonnet-4-5", isDefault: false },
    ];
    const models = hermesProfilesToModels(profiles);
    expect(models.map((m) => m.id)).toEqual(["default", "work"]);
  });

  it("de-duplicates profiles that map to the same stable id, keeping the first occurrence", () => {
    const profiles: HermesProfileSummary[] = [
      { name: "default", model: "MiniMax-M3", isDefault: true },
      { name: "default", model: "claude-sonnet-4-5", isDefault: false },
    ];
    const models = hermesProfilesToModels(profiles);
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("default (MiniMax-M3)");
  });

  it("returns an empty array for an empty profile list", () => {
    expect(hermesProfilesToModels([])).toEqual([]);
  });
});

describe("getHermesPickerModels caching", () => {
  it("fetches once and returns mapped models", async () => {
    mockedList.mockResolvedValue([{ name: "default", model: "MiniMax-M3", isDefault: true }]);

    const models = await getHermesPickerModels({ binaryPath: "hermes-test-1" });

    expect(models).toEqual([
      { provider: "hermes", id: "default", name: "default (MiniMax-M3)", reasoning: false, contextWindow: 0 },
    ]);
    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it("serves subsequent requests within the TTL window from cache with no additional spawn", async () => {
    mockedList.mockResolvedValue([{ name: "default", isDefault: true }]);
    let clock = 1000;
    const now = () => clock;

    await getHermesPickerModels({ binaryPath: "hermes-test-2", ttlMs: 60_000, now });
    clock += 30_000; // still inside the 60s TTL
    await getHermesPickerModels({ binaryPath: "hermes-test-2", ttlMs: 60_000, now });

    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it("refreshes after the TTL window expires", async () => {
    mockedList.mockResolvedValue([{ name: "default", isDefault: true }]);
    let clock = 1000;
    const now = () => clock;

    await getHermesPickerModels({ binaryPath: "hermes-test-3", ttlMs: 1_000, now });
    clock += 1_001; // past the 1s TTL
    await getHermesPickerModels({ binaryPath: "hermes-test-3", ttlMs: 1_000, now });

    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent requests for the same binaryPath", async () => {
    let resolveFetch: (v: HermesProfileSummary[]) => void = () => {};
    mockedList.mockImplementation(
      () =>
        new Promise<HermesProfileSummary[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const p1 = getHermesPickerModels({ binaryPath: "hermes-test-4" });
    const p2 = getHermesPickerModels({ binaryPath: "hermes-test-4" });

    resolveFetch([{ name: "default", isDefault: true }]);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual(r2);
    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it("degrades to an empty array (never throws) when the CLI fetch fails, and caches the empty result", async () => {
    mockedList.mockRejectedValue(new Error("hermes profile list failed: binary not found"));
    let clock = 1000;
    const now = () => clock;

    const first = await getHermesPickerModels({ binaryPath: "hermes-test-5", ttlMs: 60_000, now });
    expect(first).toEqual([]);

    clock += 10; // still inside TTL
    const second = await getHermesPickerModels({ binaryPath: "hermes-test-5", ttlMs: 60_000, now });
    expect(second).toEqual([]);

    // The failure result is cached too — only one spawn attempt within the TTL window.
    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it("resolves binaryPath from HERMES_BIN env when not explicitly provided", async () => {
    const prevEnv = process.env.HERMES_BIN;
    process.env.HERMES_BIN = "/custom/path/to/hermes";
    mockedList.mockResolvedValue([]);

    try {
      await getHermesPickerModels();
      expect(mockedList).toHaveBeenCalledWith({ binaryPath: "/custom/path/to/hermes" });
    } finally {
      if (prevEnv === undefined) delete process.env.HERMES_BIN;
      else process.env.HERMES_BIN = prevEnv;
    }
  });

  it("caches distinct binaryPaths independently", async () => {
    mockedList.mockResolvedValue([{ name: "default", isDefault: true }]);

    await getHermesPickerModels({ binaryPath: "hermes-test-6a" });
    await getHermesPickerModels({ binaryPath: "hermes-test-6b" });

    expect(mockedList).toHaveBeenCalledTimes(2);
  });
});
