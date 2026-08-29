import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";

function makeConstructibleMock<T extends (...args: any[]) => unknown>(impl?: T) {
  const mock = vi.fn(function () {});
  const originalMockImplementation = mock.mockImplementation.bind(mock);
  const originalMockImplementationOnce = mock.mockImplementationOnce.bind(mock);
  const wrap = (nextImpl: T) => function (this: unknown, ...args: Parameters<T>) {
    return nextImpl(...args);
  };
  mock.mockImplementation = ((nextImpl: T) => originalMockImplementation(wrap(nextImpl))) as typeof mock.mockImplementation;
  mock.mockImplementationOnce = ((nextImpl: T) => originalMockImplementationOnce(wrap(nextImpl))) as typeof mock.mockImplementationOnce;
  if (impl) {
    mock.mockImplementation(impl);
  }
  return mock;
}

const CLI_PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as { version: string }
).version;

const { cacheDir, mockResolveGlobalDir } = vi.hoisted(() => {
  const dir = `/tmp/fusion-update-cache-test-${process.pid}-${Date.now()}`;
  return {
    cacheDir: dir,
    mockResolveGlobalDir: vi.fn().mockReturnValue(dir),
  };
});

vi.mock("@fusion/core", () => ({
  resolveGlobalDir: mockResolveGlobalDir,
  resolveUpdatesExternallyManaged: () => process.env.FUSION_UPDATES_EXTERNALLY_MANAGED === "1",
  GlobalSettingsStore: makeConstructibleMock(),
}));

const { getCachedUpdateStatus, isUpdateCheckEnabled } = await import("../update-cache.js");

function writeUpdateCache(payload: { updateAvailable: boolean; latestVersion: string; currentVersion: string }): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(`${cacheDir}/update-check.json`, JSON.stringify(payload), "utf-8");
}

beforeEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  mockResolveGlobalDir.mockReset();
  mockResolveGlobalDir.mockReturnValue(cacheDir);
});

describe("isUpdateCheckEnabled", () => {
  it("suppresses the startup nag for an externally managed deployment", async () => {
    process.env.FUSION_UPDATES_EXTERNALLY_MANAGED = "1";
    await expect(isUpdateCheckEnabled()).resolves.toBe(false);
    delete process.env.FUSION_UPDATES_EXTERNALLY_MANAGED;
  });
});

describe("getCachedUpdateStatus", () => {
  it("returns the cached update when it matches the installed CLI version", () => {
    writeUpdateCache({
      updateAvailable: true,
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: "9.9.9",
    });

    expect(getCachedUpdateStatus(CLI_PACKAGE_VERSION)).toEqual({
      updateAvailable: true,
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: "9.9.9",
    });
  });

  it("ignores stale cached updates from a different installed CLI version", () => {
    writeUpdateCache({
      updateAvailable: true,
      currentVersion: "0.0.1",
      latestVersion: "9.9.9",
    });

    expect(getCachedUpdateStatus(CLI_PACKAGE_VERSION)).toBeNull();
  });
});
