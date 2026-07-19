import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearUpdateCheckCache,
  performUpdateCheck,
  performUpdateInstall,
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

  it("ignores a fresh cache entry after the installed version changes", async () => {
    const cached: UpdateCheckResult = {
      currentVersion: "0.8.1",
      latestVersion: "0.8.3",
      updateAvailable: true,
      lastChecked: Date.now(),
    };

    await writeFile(join(fusionDir, "update-check.json"), JSON.stringify(cached), "utf-8");

    const fetchSpy = vi.fn().mockResolvedValue({
      json: async () => ({
        "dist-tags": {
          latest: "0.8.3",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await performUpdateCheck(fusionDir, "0.8.3");

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result).toEqual({
      currentVersion: "0.8.3",
      latestVersion: "0.8.3",
      updateAvailable: false,
      lastChecked: expect.any(Number),
      channel: "stable",
    });
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

  it("handles registry version comparisons for the update-notification invariant", async () => {
    /*
     * FNXC:UpdateNotifications 2026-07-09-00:00:
     * The dashboard core is the shared npm-release detector for routes and banners. A strictly newer latest tag must announce an update, while equal, older, prerelease/build-equivalent, and short/long segment variants must not create false positives.
     */
    const cases = [
      { latest: "1.2.3", current: "1.2.3", expected: false },
      { latest: "1.2.4", current: "1.2.3", expected: true },
      { latest: "1.2.2", current: "1.2.3", expected: false },
      { latest: "1.2.4-beta.1", current: "1.2.3", expected: true },
      { latest: "1.2.3+build.7", current: "1.2.3", expected: false },
      { latest: "1.2", current: "1.2.0", expected: false },
      { latest: "1.2.0.9", current: "1.2.0", expected: false },
      { latest: "1.10.0", current: "1.9.9", expected: true },
    ];

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    for (const testCase of cases) {
      await clearUpdateCheckCache(fusionDir);
      fetchSpy.mockResolvedValueOnce({
        json: async () => ({ "dist-tags": { latest: testCase.latest } }),
      });

      const result = await performUpdateCheck(fusionDir, testCase.current);

      expect(result.updateAvailable, `${testCase.latest} vs ${testCase.current}`).toBe(testCase.expected);
    }
  });

  it("fails closed without fetching when current version is unresolved", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(performUpdateCheck(fusionDir, "0.0.0", { force: true })).resolves.toEqual(
      expect.objectContaining({
        currentVersion: "0.0.0",
        latestVersion: null,
        updateAvailable: false,
        error: "Current Fusion version is unavailable",
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it("performUpdateInstall installs latest and clears the update-check cache", async () => {
    const cachePath = join(fusionDir, "update-check.json");
    await writeFile(cachePath, JSON.stringify({ ok: true }), "utf-8");
    const execFake = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    const result = await performUpdateInstall("1.0.0", "2.0.0", { exec: execFake, fusionDir });

    // FNXC:UpdateChannels 2026-07-19-13:40: installs pin the exact resolved
    // version so a beta-channel install can never silently land on `latest`.
    expect(execFake).toHaveBeenCalledWith("npm install -g @runfusion/fusion@2.0.0", {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(result).toEqual({ currentVersion: "1.0.0", latestVersion: "2.0.0", updated: true });
    expect(existsSync(cachePath)).toBe(false);
  });

  it("performUpdateInstall retries once with --force for legacy bin collisions", async () => {
    const collision = Object.assign(new Error("EEXIST: file already exists, /usr/local/bin/fn"), {
      stderr: "runfusion.ai legacy bin collision",
    });
    const execFake = vi
      .fn()
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await performUpdateInstall("1.0.0", "2.0.0", { exec: execFake, fusionDir });

    expect(execFake).toHaveBeenCalledTimes(2);
    expect(execFake).toHaveBeenNthCalledWith(1, "npm install -g @runfusion/fusion@2.0.0", expect.any(Object));
    expect(execFake).toHaveBeenNthCalledWith(2, "npm install --force -g @runfusion/fusion@2.0.0", expect.any(Object));
    expect(result).toEqual({ currentVersion: "1.0.0", latestVersion: "2.0.0", updated: true });
  });

  it("performUpdateInstall returns an error result for non-collision install failures", async () => {
    const execFake = vi.fn().mockRejectedValue(Object.assign(new Error("npm unavailable"), { stderr: "registry down" }));

    await expect(performUpdateInstall("1.0.0", "2.0.0", { exec: execFake, fusionDir })).resolves.toEqual({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      updated: false,
      error: "registry down",
    });
    expect(execFake).toHaveBeenCalledTimes(1);
  });

  // FNXC:UpdateInstallPermissions 2026-07-10-14:00: a root-owned global dir
  // (from `sudo npm i -g`) makes the non-root in-app updater fail with EACCES/
  // EPERM. It must surface actionable remediation, not raw npm stderr, and must
  // NOT retry with --force (which cannot grant write permission).
  it("performUpdateInstall returns actionable guidance on an EACCES permission failure", async () => {
    const execFake = vi.fn().mockRejectedValue(
      Object.assign(new Error("EACCES"), {
        code: "EACCES",
        stderr: "npm error EACCES: permission denied, rename '/usr/lib/node_modules/@runfusion/fusion'",
      }),
    );

    const result = await performUpdateInstall("1.0.0", "2.0.0", { exec: execFake, fusionDir });
    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/EACCES\/EPERM|not writable|sudo/i);
    // Must not fall through to raw npm stderr, and must not retry with --force.
    expect(result.error).not.toContain("rename '/usr/lib/node_modules");
    expect(execFake).toHaveBeenCalledTimes(1);
  });

  it("performUpdateInstall detects EPERM from stderr text without an error code", async () => {
    const execFake = vi.fn().mockRejectedValue(
      Object.assign(new Error("install failed"), {
        stderr: "npm error code EPERM\nnpm error operation not permitted",
      }),
    );

    const result = await performUpdateInstall("1.0.0", "2.0.0", { exec: execFake, fusionDir });
    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/not writable|sudo/i);
    expect(execFake).toHaveBeenCalledTimes(1);
  });

  // FNXC:UpdateInstallPermissions 2026-07-10-16:00: an Intel-macOS Homebrew install
  // resolves through `/usr/local/Cellar/…` (not `/usr/local/Homebrew/`), so the
  // remediation must recommend `brew upgrade`, not the npm/sudo guidance.
  it("performUpdateInstall recommends brew for an Intel-macOS Homebrew install path", async () => {
    const originalArgv1 = process.argv[1];
    process.argv[1] = "/usr/local/Cellar/fusion/0.57.0/bin/fn";
    try {
      const execFake = vi.fn().mockRejectedValue(
        Object.assign(new Error("EACCES"), { code: "EACCES", stderr: "npm error EACCES" }),
      );
      const result = await performUpdateInstall("1.0.0", "2.0.0", { exec: execFake, fusionDir });
      expect(result.updated).toBe(false);
      expect(result.error).toMatch(/brew upgrade fusion/);
      expect(result.error).not.toMatch(/sudo npm/);
    } finally {
      process.argv[1] = originalArgv1;
    }
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

      // After an upgrade, ignore stale cached currentVersion instead of
      // surfacing an outdated update banner.
      const afterUpgrade = await performUpdateCheck(fusionDir, "0.8.3", { frequency: "manual" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(afterUpgrade).toEqual({
        currentVersion: "0.8.3",
        latestVersion: null,
        updateAvailable: false,
        lastChecked: expect.any(Number),
        channel: "stable",
      });

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

  /*
  FNXC:UpdateChannels 2026-07-19-13:40:
  Channel behavior invariants across all update surfaces:
  - stable NEVER sees the beta dist-tag;
  - beta resolves semver-max(latest, beta) so a promoted stable overtakes a beta;
  - prerelease ordering is real semver (0.73.0-beta.2 < -beta.3 < 0.73.0);
  - a cache written for another channel is never served.
  */
  describe("release channels", () => {
    const stubTags = (tags: Record<string, string>) => {
      const fetchSpy = vi.fn().mockResolvedValue({ json: async () => ({ "dist-tags": tags }) });
      vi.stubGlobal("fetch", fetchSpy);
      return fetchSpy;
    };

    it("stable channel ignores the beta dist-tag entirely", async () => {
      stubTags({ latest: "0.72.0", beta: "0.73.0-beta.2" });

      const result = await performUpdateCheck(fusionDir, "0.72.0", { channel: "stable", force: true });

      expect(result.latestVersion).toBe("0.72.0");
      expect(result.updateAvailable).toBe(false);
      expect(result.channel).toBe("stable");
    });

    it("beta channel offers the beta when it is ahead of latest", async () => {
      stubTags({ latest: "0.72.0", beta: "0.73.0-beta.2" });

      const result = await performUpdateCheck(fusionDir, "0.72.0", { channel: "beta", force: true });

      expect(result.latestVersion).toBe("0.73.0-beta.2");
      expect(result.updateAvailable).toBe(true);
      expect(result.channel).toBe("beta");
    });

    it("beta channel offers a promoted stable once it overtakes the beta", async () => {
      stubTags({ latest: "0.73.0", beta: "0.73.0-beta.4" });

      const result = await performUpdateCheck(fusionDir, "0.73.0-beta.4", { channel: "beta", force: true });

      expect(result.latestVersion).toBe("0.73.0");
      expect(result.updateAvailable).toBe(true);
    });

    it("orders prerelease identifiers numerically (beta.2 < beta.10)", async () => {
      stubTags({ latest: "0.72.0", beta: "0.73.0-beta.10" });

      const result = await performUpdateCheck(fusionDir, "0.73.0-beta.2", { channel: "beta", force: true });

      expect(result.latestVersion).toBe("0.73.0-beta.10");
      expect(result.updateAvailable).toBe(true);
    });

    it("does not offer a stable release below the running beta (no downgrade)", async () => {
      stubTags({ latest: "0.72.0", beta: "0.73.0-beta.1" });

      const result = await performUpdateCheck(fusionDir, "0.73.0-beta.1", { channel: "beta", force: true });

      expect(result.latestVersion).toBe("0.73.0-beta.1");
      expect(result.updateAvailable).toBe(false);
    });

    it("stable channel does not report a running beta as updatable to an older stable", async () => {
      stubTags({ latest: "0.72.0", beta: "0.73.0-beta.1" });

      const result = await performUpdateCheck(fusionDir, "0.73.0-beta.1", { channel: "stable", force: true });

      expect(result.latestVersion).toBe("0.72.0");
      expect(result.updateAvailable).toBe(false);
    });

    it("ignores a fresh cache written for a different channel", async () => {
      const cached: UpdateCheckResult = {
        currentVersion: "0.72.0",
        latestVersion: "0.72.0",
        updateAvailable: false,
        lastChecked: Date.now(),
        channel: "stable",
      };
      await writeFile(join(fusionDir, "update-check.json"), JSON.stringify(cached), "utf-8");

      const fetchSpy = stubTags({ latest: "0.72.0", beta: "0.73.0-beta.1" });
      const result = await performUpdateCheck(fusionDir, "0.72.0", { channel: "beta" });

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(result.latestVersion).toBe("0.73.0-beta.1");
      expect(result.updateAvailable).toBe(true);
    });

    it("treats a channel-less legacy cache as stable", async () => {
      const cached: UpdateCheckResult = {
        currentVersion: "0.72.0",
        latestVersion: "0.72.1",
        updateAvailable: true,
        lastChecked: Date.now(),
      };
      await writeFile(join(fusionDir, "update-check.json"), JSON.stringify(cached), "utf-8");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const result = await performUpdateCheck(fusionDir, "0.72.0", { channel: "stable" });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result).toEqual(cached);
    });

    it("pins the beta version in the install command", async () => {
      const execFake = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

      await performUpdateInstall("0.72.0", "0.73.0-beta.2", { exec: execFake, fusionDir });

      expect(execFake).toHaveBeenCalledWith("npm install -g @runfusion/fusion@0.73.0-beta.2", expect.any(Object));
    });

    // FNXC:UpdateChannels 2026-07-19-16:20: the exec path is only reachable
    // with a strict-semver-shaped target — no null fallback to @latest (which
    // would cross release tracks) and no registry-poisoned shell input.
    it("refuses to install when no target version resolved (no @latest fallback)", async () => {
      const execFake = vi.fn();

      const result = await performUpdateInstall("0.72.0", null, { exec: execFake, fusionDir });

      expect(execFake).not.toHaveBeenCalled();
      expect(result.updated).toBe(false);
      expect(result.error).toContain("No valid update target version");
    });

    it("refuses to install a non-semver registry value (shell-injection hardening)", async () => {
      const execFake = vi.fn();

      const result = await performUpdateInstall("0.72.0", "1.2.3; rm -rf ~", { exec: execFake, fusionDir });

      expect(execFake).not.toHaveBeenCalled();
      expect(result.updated).toBe(false);
      expect(result.error).toContain("No valid update target version");
    });
  });
});
