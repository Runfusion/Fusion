import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  existingPaths: new Set<string>(),
  files: new Map<string, string>(),
  mtimes: new Map<string, number>(),
  indexHtml: "",
};

vi.mock("node:fs", () => ({
  existsSync: (path: string) => state.existingPaths.has(path) || state.files.has(path),
  readFileSync: (path: string) => {
    if (state.files.has(path)) return state.files.get(path)!;
    if (state.existingPaths.has(path)) return state.indexHtml;
    const error = new Error(`ENOENT: ${path}`) as Error & { code: string };
    error.code = "ENOENT";
    throw error;
  },
  mkdirSync: (path: string) => {
    if (state.existingPaths.has(path) || state.files.has(path)) {
      const error = new Error(`EEXIST: ${path}`) as Error & { code: string };
      error.code = "EEXIST";
      throw error;
    }
    state.existingPaths.add(path);
    state.mtimes.set(path, 0);
  },
  writeFileSync: (path: string, content: string) => {
    state.files.set(path, content);
  },
  renameSync: (from: string, to: string) => {
    state.files.set(to, state.files.get(from)!);
    state.files.delete(from);
  },
  rmSync: (path: string) => {
    for (const existing of [...state.existingPaths]) {
      if (existing === path || existing.startsWith(`${path}/`)) state.existingPaths.delete(existing);
    }
    for (const file of [...state.files.keys()]) {
      if (file === path || file.startsWith(`${path}/`)) state.files.delete(file);
    }
  },
  statSync: (path: string) => ({ mtimeMs: state.mtimes.get(path) ?? 0 }),
}));

import {
  BUILD_LOCK_STALE_MS,
  buildCliWithRealDashboardAssets,
  clientIndexPath,
  dashboardClientStubMarker,
  hasBuiltDashboardAssets,
  requiredBuildAssetPaths,
} from "./bundle-output-helpers";

function addAllAssets() {
  for (const path of requiredBuildAssetPaths) state.existingPaths.add(path);
  state.files.set(clientIndexPath, state.indexHtml);
}

/**
 * FNXC:TestInfrastructure 2026-07-16-09:10:
 * The fake filesystem plus awaitable waitTick drives every build-lock branch
 * deterministically. Loaded-lane parallelism is only a symptom check, never
 * the proof that a waiter preserves live ownership or recovers stale holders.
 */
describe("hasBuiltDashboardAssets", () => {
  beforeEach(() => {
    state.existingPaths.clear();
    state.files.clear();
    state.mtimes.clear();
    state.indexHtml = "<html><body><script src=\"assets/app.js\"></script></body></html>";
  });

  it("returns false when a required asset is missing", () => {
    addAllAssets();
    state.existingPaths.delete(requiredBuildAssetPaths.at(-1)!);

    expect(hasBuiltDashboardAssets()).toBe(false);
  });

  it("returns true when all required assets exist and dashboard stub marker is absent", () => {
    addAllAssets();

    expect(hasBuiltDashboardAssets()).toBe(true);
  });

  it("returns false when dashboard client index contains stub marker", () => {
    state.indexHtml = dashboardClientStubMarker;
    addAllAssets();

    expect(hasBuiltDashboardAssets()).toBe(false);
  });
});

describe("buildCliWithRealDashboardAssets lock protocol", () => {
  beforeEach(() => {
    state.existingPaths.clear();
    state.files.clear();
    state.mtimes.clear();
  });

  it("winner writes owner metadata, builds, and releases its lock", async () => {
    const lockDir = "/locks/winner";
    let assetsReady = false;
    const build = vi.fn(async () => { assetsReady = true; });

    await buildCliWithRealDashboardAssets({ lockDir, hasAssets: () => assetsReady, build, now: () => 10 });

    expect(build).toHaveBeenCalledTimes(1);
    expect(state.files.get(`${lockDir}/owner.json`)).toBeUndefined();
    expect(state.existingPaths.has(lockDir)).toBe(false);
  });

  it("waits for a live owner, then reads completed assets without reclaiming or rebuilding", async () => {
    const lockDir = "/locks/live-owner";
    let assetsReady = false;
    state.existingPaths.add(lockDir);
    state.files.set(`${lockDir}/owner.json`, JSON.stringify({ pid: 99, acquiredAt: 100 }));
    state.mtimes.set(lockDir, 100);
    const build = vi.fn();
    const waitTick = vi.fn(async () => {
      assetsReady = true;
      state.existingPaths.delete(lockDir);
      state.files.delete(`${lockDir}/owner.json`);
    });

    await buildCliWithRealDashboardAssets({
      lockDir,
      hasAssets: () => assetsReady,
      build,
      now: () => 101,
      isProcessAlive: (pid) => pid === 99,
      statMtimeMs: () => 100,
      waitTick,
    });

    expect(waitTick).toHaveBeenCalledTimes(1);
    expect(build).not.toHaveBeenCalled();
  });

  it("atomically reclaims a dead owner past the stale threshold and rebuilds", async () => {
    const lockDir = "/locks/dead-owner";
    let assetsReady = false;
    state.existingPaths.add(lockDir);
    state.files.set(`${lockDir}/owner.json`, JSON.stringify({ pid: 404, acquiredAt: 0 }));
    state.mtimes.set(lockDir, 0);
    const build = vi.fn(async () => { assetsReady = true; });

    await buildCliWithRealDashboardAssets({
      lockDir,
      hasAssets: () => assetsReady,
      build,
      now: () => BUILD_LOCK_STALE_MS + 1,
      isProcessAlive: () => false,
      statMtimeMs: () => 0,
    });

    expect(build).toHaveBeenCalledTimes(1);
    expect(state.existingPaths.has(lockDir)).toBe(false);
  });

  it("reclaims missing owner metadata using the stale directory mtime fallback", async () => {
    const lockDir = "/locks/missing-owner";
    let assetsReady = false;
    state.existingPaths.add(lockDir);
    state.mtimes.set(lockDir, 0);
    const build = vi.fn(async () => { assetsReady = true; });

    await buildCliWithRealDashboardAssets({
      lockDir,
      hasAssets: () => assetsReady,
      build,
      now: () => BUILD_LOCK_STALE_MS + 1,
      isProcessAlive: () => true,
      statMtimeMs: () => 0,
    });

    expect(build).toHaveBeenCalledTimes(1);
    expect(state.existingPaths.has(lockDir)).toBe(false);
  });
});
