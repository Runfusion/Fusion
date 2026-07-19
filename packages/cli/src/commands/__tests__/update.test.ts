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

    expect(execAsyncMock).toHaveBeenCalledWith("npm install -g @runfusion/fusion@latest", expect.objectContaining({ timeout: 300_000 }));
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

  it("retries once with --force when EEXIST bin collision is detected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: "1.2.4" } }) }));
    execAsyncMock
      .mockRejectedValueOnce(new Error("npm ERR! code EEXIST\nnpm ERR! path /usr/local/bin/fn\nnpm ERR! File exists"))
      .mockResolvedValueOnce({ stdout: "ok", stderr: "" });

    await runUpdate();

    expect(execAsyncMock).toHaveBeenCalledTimes(2);
    expect((execAsyncMock.mock.calls[1] ?? [""])[0]).toContain("npm install --force -g @runfusion/fusion@latest");
    expect(errorSpy).toHaveBeenCalledWith("Detected legacy runfusion.ai bin symlinks; retrying update with --force.");
    expect(logSpy).toHaveBeenCalledWith("Update complete.");
  });

  it("retries local install with --force when collision detected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: "1.2.4" } }) }));
    execAsyncMock
      .mockRejectedValueOnce(new Error("npm ERR! code EEXIST\nnpm ERR! path /usr/local/bin/fusion\nnpm ERR! File exists"))
      .mockResolvedValueOnce({ stdout: "ok", stderr: "" });

    await runUpdate({ global: false });

    expect(execAsyncMock).toHaveBeenCalledTimes(2);
    expect((execAsyncMock.mock.calls[1] ?? [""])[0]).toContain("npm install --force @runfusion/fusion@latest");
    expect((execAsyncMock.mock.calls[1] ?? [""])[0]).not.toContain(" -g ");
  });

  it("shows remediation when forced retry also fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: "1.2.4" } }) }));
    execAsyncMock
      .mockRejectedValueOnce(new Error("npm ERR! code EEXIST\nnpm ERR! path /opt/homebrew/bin/fn\nnpm ERR! File exists"))
      .mockRejectedValueOnce(new Error("npm ERR! code EEXIST\nnpm ERR! path /opt/homebrew/bin/fn\nnpm ERR! File exists"));

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue(["node", "/opt/homebrew/bin/fn"]);

    await expect(runUpdate()).rejects.toThrow("process.exit:1");

    argvSpy.mockRestore();
    expect(execAsyncMock).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith("Legacy runfusion.ai bin links blocked automatic update. Run:");
    expect(errorSpy).toHaveBeenCalledWith("  npm uninstall -g runfusion.ai");
    expect(errorSpy).toHaveBeenCalledWith("  rm -f $(command -v fn) $(command -v fusion)");
    expect(errorSpy).toHaveBeenCalledWith("  npm install -g @runfusion/fusion@latest");
    expect(errorSpy).toHaveBeenCalledWith("  brew uninstall fusion && brew install runfusion/tap/fusion");
  });

  it("returns helpful error when npm install fails without collision", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: "1.2.4" } }) }));
    execAsyncMock.mockRejectedValue(new Error("network down"));

    await expect(runUpdate()).rejects.toThrow("process.exit:1");

    expect(execAsyncMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("Error installing update: network down");
  });

  it("reports a timeout instead of npm deprecation warnings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: "1.2.4" } }) }));
    execAsyncMock.mockRejectedValue(
      Object.assign(new Error("Command failed"), {
        killed: true,
        signal: "SIGTERM",
        stderr: "npm warn deprecated prebuild-install@7.1.3: No longer maintained.",
      }),
    );

    await expect(runUpdate()).rejects.toThrow("process.exit:1");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/timed out after 5 minutes.*terminal/i));
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "npm install -g @runfusion/fusion@latest",
    );
    expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("npm install --force");
    expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("deprecated");
  });

  it("reports a timeout when the forced collision retry stalls", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: "1.2.4" } }) }));
    execAsyncMock
      .mockRejectedValueOnce(new Error("npm ERR! code EEXIST\nnpm ERR! path /usr/local/bin/fn\nnpm ERR! File exists"))
      .mockRejectedValueOnce(
        Object.assign(new Error("Command failed"), {
          killed: true,
          stderr: "npm warn deprecated prebuild-install@7.1.3: No longer maintained.",
        }),
      );

    await expect(runUpdate()).rejects.toThrow("process.exit:1");

    expect(execAsyncMock).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/timed out after 5 minutes.*terminal/i));
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "npm install --force -g @runfusion/fusion@latest",
    );
    expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("deprecated");
  });

  it("preserves a registry ETIMEDOUT diagnosis", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: "1.2.4" } }) }));
    execAsyncMock.mockRejectedValue(
      Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:443"), { killed: false }),
    );

    await expect(runUpdate()).rejects.toThrow("process.exit:1");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("connect ETIMEDOUT"));
    expect(errorSpy.mock.calls.flat().join("\n")).not.toMatch(/timed out after 5 minutes/i);
  });


  it("uses identical comparison semantics for CLI update notifications", async () => {
    /*
     * FNXC:UpdateNotifications 2026-07-09-00:00:
     * The CLI command is the install-capable update surface. It must agree with the dashboard detector so fresh npm releases notify in --check/--json mode, while equal, older, and version-string edge cases stay quiet.
     */
    const cases = [
      { latest: "1.2.3", current: "1.2.3", expectedExitCode: 0, expectedAvailable: false },
      { latest: "1.2.4", current: "1.2.3", expectedExitCode: 1, expectedAvailable: true },
      { latest: "1.2.2", current: "1.2.3", expectedExitCode: 0, expectedAvailable: false },
      { latest: "1.2.4-beta.1", current: "1.2.3", expectedExitCode: 1, expectedAvailable: true },
      { latest: "1.2.3+build.7", current: "1.2.3", expectedExitCode: 0, expectedAvailable: false },
      { latest: "1.2", current: "1.2.0", expectedExitCode: 0, expectedAvailable: false },
      { latest: "1.2.0.9", current: "1.2.0", expectedExitCode: 0, expectedAvailable: false },
    ];

    for (const testCase of cases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ "dist-tags": { latest: testCase.latest } }) }));
      readFileSyncMock.mockReturnValueOnce(JSON.stringify({ name: "@runfusion/fusion", version: testCase.current }));
      logSpy.mockClear();
      process.exitCode = 0;

      await runUpdate({ check: true, json: true });

      const output = logSpy.mock.calls[0]?.[0] as string;
      expect(JSON.parse(output), `${testCase.latest} vs ${testCase.current}`).toMatchObject({
        currentVersion: testCase.current,
        latestVersion: testCase.latest,
        updateAvailable: testCase.expectedAvailable,
        updated: false,
      });
      expect(process.exitCode).toBe(testCase.expectedExitCode);
    }
  });

  it("does not announce equal or older cached fallback metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    for (const latestVersion of ["1.2.3", "1.2.2"]) {
      getCachedUpdateStatusMock.mockReturnValueOnce({
        updateAvailable: true,
        currentVersion: "1.2.3",
        latestVersion,
      });
      logSpy.mockClear();
      process.exitCode = 0;

      await runUpdate({ check: true, json: true });

      const output = logSpy.mock.calls.at(-1)?.[0] as string;
      expect(JSON.parse(output)).toMatchObject({
        currentVersion: "1.2.3",
        latestVersion,
        updateAvailable: false,
      });
      expect(process.exitCode).toBe(0);
    }
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
