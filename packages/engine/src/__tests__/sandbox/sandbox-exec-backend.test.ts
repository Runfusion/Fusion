import { cwd } from "node:process";
import { promisify } from "node:util";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { detectMock, policyToProfileMock, presetMock, nativeRunMock, nativePrepareMock, nativeDisposeMock, loggerMock, execMock } = vi.hoisted(() => ({
  detectMock: vi.fn(),
  policyToProfileMock: vi.fn(),
  presetMock: vi.fn(),
  nativeRunMock: vi.fn(),
  nativePrepareMock: vi.fn(),
  nativeDisposeMock: vi.fn(),
  loggerMock: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  execMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: vi.fn(),
}));

vi.mock("../../sandbox/sandbox-exec-detect.js", () => ({
  detectSandboxExec: detectMock,
}));

vi.mock("../../sandbox/sandbox-exec-policy.js", () => ({
  policyToSbplProfile: policyToProfileMock,
  fusionWorktreePreset: presetMock,
}));

vi.mock("../../logger.js", () => ({
  createLogger: () => loggerMock,
}));

vi.mock("../../sandbox/native.js", () => ({
  NativeSandboxBackend: class {
    prepare = nativePrepareMock;
    run = nativeRunMock;
    runStreaming = vi.fn();
    dispose = nativeDisposeMock;
    capabilities() {
      return { id: "native", supportsNetworkPolicy: false, supportsFilesystemPolicy: false, supportsStreaming: true, platform: "any" };
    }
  },
}));

describe("SandboxExecBackend", () => {
  beforeEach(() => {
    vi.resetModules();
    detectMock.mockReset();
    policyToProfileMock.mockReset();
    presetMock.mockReset();
    nativeRunMock.mockReset();
    nativePrepareMock.mockReset();
    nativeDisposeMock.mockReset();
    execMock.mockReset();
    (execMock as unknown as Record<symbol, unknown>)[promisify.custom] = vi.fn();
    loggerMock.log.mockReset();
    loggerMock.warn.mockReset();
    loggerMock.error.mockReset();
    loggerMock.debug.mockReset();
  });

  it("reports capabilities", async () => {
    const { SandboxExecBackend } = await import("../../sandbox/sandbox-exec-backend.js");
    const backend = new SandboxExecBackend();
    expect(backend.capabilities().id).toBe("sandbox-exec");
  });

  it("throws on prepare fail-hard when unavailable", async () => {
    detectMock.mockResolvedValue({ available: false, reason: "not-installed" });
    const { SandboxExecBackend, SandboxUnavailableError } = await import("../../sandbox/sandbox-exec-backend.js");
    const backend = new SandboxExecBackend();

    await expect(backend.prepare({ allowNetwork: true })).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("fallback-native delegates runs and logs once", async () => {
    detectMock.mockResolvedValue({ available: false, reason: "not-installed" });
    nativeRunMock.mockResolvedValue({ stdout: "native", stderr: "", exitCode: 0, signal: null, timedOut: false, bufferExceeded: false });

    const { SandboxExecBackend } = await import("../../sandbox/sandbox-exec-backend.js");
    const backend = new SandboxExecBackend();

    await backend.prepare({ allowNetwork: true, failureMode: "fallback-native" } as any);
    await backend.run("echo a", { cwd: cwd(), timeoutMs: 1_000, maxBuffer: 1024 });
    await backend.run("echo b", { cwd: cwd(), timeoutMs: 1_000, maxBuffer: 1024 });

    expect(nativeRunMock).toHaveBeenCalledTimes(2);
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn.mock.calls[0]?.[0]).toContain("sandbox:fallback");
  });

  it("executes sandbox-exec command and maps success", async () => {
    detectMock.mockResolvedValue({ available: true, path: "/usr/bin/sandbox-exec" });
    presetMock.mockReturnValue({ allowNetwork: true });
    policyToProfileMock.mockReturnValue("(version 1)\n(allow default)");
    ((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>).mockResolvedValue({ stdout: "ok", stderr: "" });

    const { SandboxExecBackend } = await import("../../sandbox/sandbox-exec-backend.js");
    const backend = new SandboxExecBackend();
    await backend.prepare({ allowNetwork: true, allowedWritePaths: [cwd()] });
    const result = await backend.run("echo hello", { cwd: cwd(), timeoutMs: 2_000, maxBuffer: 1024 * 1024 });

    const execAsyncMock = (execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>;
    const cmd = execAsyncMock.mock.calls.find((call) => String(call[0]).includes("sandbox-exec"))?.[0] as string;
    expect(cmd).toContain("sandbox-exec -p");
    expect(cmd).toContain("/bin/sh -c");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(loggerMock.log).toHaveBeenCalled();
  });

  it("maps timeout and maxBuffer failures", async () => {
    detectMock.mockResolvedValue({ available: true, path: "/usr/bin/sandbox-exec" });
    presetMock.mockReturnValue({ allowNetwork: true });
    policyToProfileMock.mockReturnValue("(version 1)\n(allow default)");
    const err = Object.assign(new Error("timed out maxBuffer"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      killed: true,
      signal: "SIGTERM",
      stdout: "",
      stderr: "boom",
    });
    ((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const { SandboxExecBackend } = await import("../../sandbox/sandbox-exec-backend.js");
    const backend = new SandboxExecBackend();
    await backend.prepare({ allowNetwork: true, allowedWritePaths: [cwd()] });
    const result = await backend.run("echo hello", { cwd: cwd(), timeoutMs: 2_000, maxBuffer: 1 });

    expect(result.bufferExceeded).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining("sandbox:failure"));
  });

  it.skipIf(process.platform !== "darwin")("runs real sandbox-exec hello integration", async () => {
    const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(childProcess.exec);

    try {
      const { stdout } = await execAsync("sandbox-exec -p '(version 1)(allow default)' /bin/echo hello", {
        cwd: cwd(),
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
      });
      expect(stdout).toBe("hello\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not found")) {
        return;
      }
      throw error;
    }
  });
});
