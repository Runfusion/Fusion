import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const { execAsyncMock, existsSyncMock, readFileSyncMock, getCachedUpdateStatusMock } = vi.hoisted(() => ({
  execAsyncMock: vi.fn<(...args: unknown[]) => Promise<{ stdout: string; stderr: string }>>(),
  existsSyncMock: vi.fn<(path: string) => boolean>(),
  readFileSyncMock: vi.fn<(path: string, encoding: BufferEncoding) => string>(),
  getCachedUpdateStatusMock: vi.fn<(currentVersion?: string) => {
    updateAvailable: boolean;
    latestVersion: string;
    currentVersion: string;
  } | null>(),
}));

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFn: Record<PropertyKey, unknown> = vi.fn();
  execFn[promisify.custom] = execAsyncMock;
  return { exec: execFn };
});

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));

vi.mock("../../update-cache.js", () => ({
  getCachedUpdateStatus: getCachedUpdateStatusMock,
}));

import { runUpdate } from "../update.js";

describe("runUpdate", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;

    existsSyncMock.mockImplementation((path: string) => path.endsWith("package.json"));
    readFileSyncMock.mockReturnValue(JSON.stringify({ name: "@runfusion/fusion", version: "1.2.3" }));
    getCachedUpdateStatusMock.mockReturnValue(null);

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("reports already up to date when current version matches latest", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: "1.2.3" } }) }));

    await runUpdate();

    expect(execAsyncMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("Already up to date.");
  });

  it("installs when update is available", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: "1.2.4" } }) }));
    execAsyncMock.mockResolvedValue({ stdout: "ok", stderr: "" });

    await runUpdate();

    expect(execAsyncMock).toHaveBeenCalledWith("npm install -g @runfusion/fusion@latest", expect.objectContaining({ timeout: 120_000 }));
    expect(logSpy).toHaveBeenCalledWith("Update complete.");
  });

  it("check mode reports availability without installing and sets exit code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: "1.2.4" } }) }));

    await runUpdate({ check: true });

    expect(execAsyncMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("Update available.");
    expect(process.exitCode).toBe(1);
  });

  it("json mode outputs expected payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: "1.2.3" } }) }));

    await runUpdate({ json: true });

    const output = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as {
      currentVersion: string;
      latestVersion: string;
      updateAvailable: boolean;
      updated: boolean;
    };

    expect(parsed).toEqual({
      currentVersion: "1.2.3",
      latestVersion: "1.2.3",
      updateAvailable: false,
      updated: false,
    });
  });

  it("returns helpful error on network failure without cache", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(runUpdate({ check: true })).rejects.toThrow("process.exit:1");

    expect(errorSpy).toHaveBeenCalledWith("Error checking for updates: network down");
  });

  it("uses cached version when network fails in check mode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    getCachedUpdateStatusMock.mockReturnValue({
      updateAvailable: true,
      currentVersion: "1.2.3",
      latestVersion: "1.2.5",
    });

    await runUpdate({ check: true });

    expect(logSpy).toHaveBeenCalledWith("Warning: npm registry unreachable, using cached update metadata.");
    expect(logSpy).toHaveBeenCalledWith("Latest version: 1.2.5");
    expect(process.exitCode).toBe(1);
  });

  it("returns helpful error when npm install fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: "1.2.4" } }) }));
    execAsyncMock.mockRejectedValue(new Error("permission denied"));

    await expect(runUpdate()).rejects.toThrow("process.exit:1");

    expect(errorSpy).toHaveBeenCalledWith("Error installing update: permission denied");
  });

  it("handles semver comparisons for major, minor, and patch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: "2.0.0" } }) }));
    execAsyncMock.mockResolvedValue({ stdout: "ok", stderr: "" });

    readFileSyncMock.mockReturnValueOnce(JSON.stringify({ name: "@runfusion/fusion", version: "1.9.9" }));
    await runUpdate({ check: true });
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: "1.3.0" } }) }));
    readFileSyncMock.mockReturnValueOnce(JSON.stringify({ name: "@runfusion/fusion", version: "1.2.9" }));
    await runUpdate({ check: true });
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: "1.2.4" } }) }));
    readFileSyncMock.mockReturnValueOnce(JSON.stringify({ name: "@runfusion/fusion", version: "1.2.3" }));
    await runUpdate({ check: true });
    expect(process.exitCode).toBe(1);
  });
});
