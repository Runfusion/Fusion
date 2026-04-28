import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearUpdateCheckCache,
  performUpdateCheck,
  readCachedUpdateCheck,
  ttlForFrequency,
  __resetStartupRefreshFlag,
  type UpdateCheckResult,
} from "../update-check.js";

describe("update-check", () => {
  let fusionDir: string;

  beforeEach(async () => {
    fusionDir = await mkdtemp(join(tmpdir(), "fn-update-check-"));
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await clearUpdateCheckCache(fusionDir);
    vi.restoreAllMocks();
  });

  it("returns cached result when cache is still fresh", async () => {
    const cached: UpdateCheckResult = {
      currentVersion: "0.6.0",
      latestVersion: "0.7.0",
      updateAvailable: true,
      lastChecked: Date.now(),
    };

    await writeFile(join(fusionDir, "update-check.json"), JSON.stringify(cached), "utf-8");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await performUpdateCheck(fusionDir, "0.6.0");

    expect(result).toEqual(cached);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches latest version when cache is expired", async () => {
    const stale: UpdateCheckResult = {
      currentVersion: "0.6.0",
      latestVersion: "0.6.0",
      updateAvailable: false,
      lastChecked: Date.now() - 25 * 60 * 60 * 1000,
    };

    await writeFile(join(fusionDir, "update-check.json"), JSON.stringify(stale), "utf-8");

    const fetchSpy = vi.fn().mockResolvedValue({
      json: async () => ({
        "dist-tags": {
          latest: "0.8.0",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await performUpdateCheck(fusionDir, "0.6.0");

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.latestVersion).toBe("0.8.0");
    expect(result.updateAvailable).toBe(true);
  });

  it("handles semver comparisons for equal, newer, and older registry versions", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    fetchSpy.mockResolvedValueOnce({
      json: async () => ({ "dist-tags": { latest: "1.2.3" } }),
    });
    const equalResult = await performUpdateCheck(fusionDir, "1.2.3");
    expect(equalResult.updateAvailable).toBe(false);

    await clearUpdateCheckCache(fusionDir);
    fetchSpy.mockResolvedValueOnce({
      json: async () => ({ "dist-tags": { latest: "1.2.4" } }),
    });
    const newerResult = await performUpdateCheck(fusionDir, "1.2.3");
    expect(newerResult.updateAvailable).toBe(true);

    await clearUpdateCheckCache(fusionDir);
    fetchSpy.mockResolvedValueOnce({
      json: async () => ({ "dist-tags": { latest: "1.2.2" } }),
    });
    const olderResult = await performUpdateCheck(fusionDir, "1.2.3");
    expect(olderResult.updateAvailable).toBe(false);
  });

  it("returns a non-throwing error result when network fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(performUpdateCheck(fusionDir, "0.6.0")).resolves.toEqual(
      expect.objectContaining({
        currentVersion: "0.6.0",
        latestVersion: null,
        updateAvailable: false,
        error: "network down",
      }),
    );
  });

  it("clearUpdateCheckCache removes the cache file", async () => {
    const cachePath = join(fusionDir, "update-check.json");
    await writeFile(cachePath, JSON.stringify({ ok: true }), "utf-8");

    await clearUpdateCheckCache(fusionDir);

    expect(existsSync(cachePath)).toBe(false);
  });

  it("readCachedUpdateCheck returns null for missing file and parsed result when present", async () => {
    expect(readCachedUpdateCheck(fusionDir)).toBeNull();

    const value: UpdateCheckResult = {
      currentVersion: "0.6.0",
      latestVersion: "0.7.0",
      updateAvailable: true,
      lastChecked: 123,
    };

    await writeFile(join(fusionDir, "update-check.json"), JSON.stringify(value), "utf-8");

    expect(readCachedUpdateCheck(fusionDir)).toEqual(value);
  });

  describe("frequency", () => {
    beforeEach(() => {
      __resetStartupRefreshFlag();
    });

    it("ttlForFrequency: maps frequencies to expected windows", () => {
      const day = 24 * 60 * 60 * 1000;
      expect(ttlForFrequency(undefined)).toBe(day);
      expect(ttlForFrequency("daily")).toBe(day);
      expect(ttlForFrequency("weekly")).toBe(7 * day);
      expect(ttlForFrequency("manual")).toBe(Number.POSITIVE_INFINITY);
      expect(ttlForFrequency("on-startup")).toBe(Number.POSITIVE_INFINITY);
    });

    it("weekly: serves cache for up to 7 days, refetches on day 8", async () => {
      // Day-6 cache: weekly should still serve it
      const cached: UpdateCheckResult = {
        currentVersion: "0.6.0",
        latestVersion: "0.7.0",
        updateAvailable: true,
        lastChecked: Date.now() - 6 * 24 * 60 * 60 * 1000,
      };
      await writeFile(join(fusionDir, "update-check.json"), JSON.stringify(cached), "utf-8");

      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const result = await performUpdateCheck(fusionDir, "0.6.0", { frequency: "weekly" });
      expect(result).toEqual(cached);
      expect(fetchSpy).not.toHaveBeenCalled();

      // Day-8 cache: weekly should refetch
      await writeFile(
        join(fusionDir, "update-check.json"),
        JSON.stringify({ ...cached, lastChecked: Date.now() - 8 * 24 * 60 * 60 * 1000 }),
        "utf-8",
      );
      fetchSpy.mockResolvedValueOnce({
        json: async () => ({ "dist-tags": { latest: "0.9.0" } }),
      });
      const refetched = await performUpdateCheck(fusionDir, "0.6.0", { frequency: "weekly" });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(refetched.latestVersion).toBe("0.9.0");
    });

    it("manual: never hits the network unless force=true, returns cached or empty", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      // No cache → returns synthetic empty result without fetching.
      const empty = await performUpdateCheck(fusionDir, "0.6.0", { frequency: "manual" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(empty.latestVersion).toBeNull();
      expect(empty.updateAvailable).toBe(false);

      // With cache → returns cache without fetching even if "stale" by daily standards.
      const cached: UpdateCheckResult = {
        currentVersion: "0.6.0",
        latestVersion: "0.7.0",
        updateAvailable: true,
        lastChecked: Date.now() - 30 * 24 * 60 * 60 * 1000,
      };
      await writeFile(join(fusionDir, "update-check.json"), JSON.stringify(cached), "utf-8");
      const fromCache = await performUpdateCheck(fusionDir, "0.6.0", { frequency: "manual" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fromCache).toEqual(cached);

      // force=true (used by /update-check/refresh) overrides manual.
      fetchSpy.mockResolvedValueOnce({
        json: async () => ({ "dist-tags": { latest: "1.0.0" } }),
      });
      const forced = await performUpdateCheck(fusionDir, "0.6.0", {
        frequency: "manual",
        force: true,
      });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(forced.latestVersion).toBe("1.0.0");
    });

    it("on-startup: refreshes once per process, then serves cache", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        json: async () => ({ "dist-tags": { latest: "0.8.0" } }),
      });
      vi.stubGlobal("fetch", fetchSpy);

      // First call within the process: hits the network, writes cache.
      const first = await performUpdateCheck(fusionDir, "0.6.0", { frequency: "on-startup" });
      expect(first.latestVersion).toBe("0.8.0");
      expect(fetchSpy).toHaveBeenCalledOnce();

      // Subsequent call: serves the just-written cache, no network.
      const second = await performUpdateCheck(fusionDir, "0.6.0", { frequency: "on-startup" });
      expect(second.latestVersion).toBe("0.8.0");
      expect(fetchSpy).toHaveBeenCalledOnce();

      // Reset the per-process flag (simulates a fresh server boot) → next
      // call refreshes again.
      __resetStartupRefreshFlag();
      fetchSpy.mockResolvedValueOnce({
        json: async () => ({ "dist-tags": { latest: "0.9.0" } }),
      });
      const afterReboot = await performUpdateCheck(fusionDir, "0.6.0", { frequency: "on-startup" });
      expect(afterReboot.latestVersion).toBe("0.9.0");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("persists fetched results to the cache file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({ "dist-tags": { latest: "0.7.0" } }),
      }),
    );

    const result = await performUpdateCheck(fusionDir, "0.6.0");
    const cachedRaw = await readFile(join(fusionDir, "update-check.json"), "utf-8");

    expect(JSON.parse(cachedRaw)).toEqual(result);
  });
});
