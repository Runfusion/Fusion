import { execSync } from "node:child_process";
import { cwd } from "node:process";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { detectMock } = vi.hoisted(() => ({ detectMock: vi.fn() }));

vi.mock("../../sandbox/bubblewrap-detect.js", () => ({
  detectBwrap: detectMock,
}));

import { BubblewrapBackend, SandboxUnavailableError } from "../../sandbox/bubblewrap-backend.js";
import type { SandboxBackend, SandboxRunResult } from "../../sandbox/types.js";

const hasBwrap = (() => {
  try {
    return !!execSync("command -v bwrap", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return false;
  }
})();

describe("BubblewrapBackend", () => {
  beforeEach(() => {
    detectMock.mockReset();
  });

  it("reports bubblewrap capabilities", () => {
    const backend = new BubblewrapBackend();
    expect(backend.capabilities().id).toBe("bubblewrap");
    expect(backend.capabilities().supportsFilesystemPolicy).toBe(true);
  });

  it("throws on prepare when bwrap unavailable and fail-hard", async () => {
    detectMock.mockResolvedValue({ available: false, reason: "not-installed" });
    const backend = new BubblewrapBackend();

    await expect(backend.prepare({ allowNetwork: true })).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("falls back to native when requested", async () => {
    detectMock.mockResolvedValue({ available: false, reason: "not-installed" });
    const runResult: SandboxRunResult = {
      stdout: "native",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      bufferExceeded: false,
    };

    const nativeStub: SandboxBackend = {
      capabilities: () => ({ id: "native", supportsNetworkPolicy: false, supportsFilesystemPolicy: false, supportsStreaming: true, platform: "any" }),
      prepare: vi.fn(async () => undefined),
      run: vi.fn(async () => runResult),
      runStreaming: vi.fn(async () => ({ outcome: "success" as const, stdout: "", stderr: "", bufferOverflow: false })),
      dispose: vi.fn(async () => undefined),
    };

    const backend = new BubblewrapBackend(nativeStub);
    await backend.prepare({ allowNetwork: true, env: {}, allowedReadPaths: [], allowedWritePaths: [], failureMode: "fallback-native" } as any);

    const result = await backend.run("echo hi", { cwd: cwd(), timeoutMs: 1_000, maxBuffer: 1024, encoding: "utf-8" });
    expect(result.stdout).toBe("native");
    expect(nativeStub.run).toHaveBeenCalled();
  });

  it("attempts bwrap execution when available", async () => {
    detectMock.mockResolvedValue({ available: true, path: "/usr/bin/test-bwrap" });
    const runBwrap = vi.fn(async (): Promise<SandboxRunResult> => ({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      bufferExceeded: false,
    }));
    const backend = new BubblewrapBackend(undefined, runBwrap);
    await backend.prepare({ allowNetwork: true });

    const result = await backend.run("echo hello", {
      cwd: cwd(),
      timeoutMs: 5_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });

    expect(result.stdout).toBe("hello\n");
    expect(runBwrap).toHaveBeenCalledOnce();
    const [command, args] = runBwrap.mock.calls[0];
    expect(command).toBe("/usr/bin/test-bwrap");
    expect(args.at(-3)).toBe("/bin/sh");
    expect(args.at(-2)).toBe("-lc");
    expect(args.at(-1)).toBe("echo hello");
  });

  it.skipIf(process.platform !== "linux" || !hasBwrap)("runs real bubblewrap hello integration", async () => {
    vi.doUnmock("../../sandbox/bubblewrap-detect.js");
    const { BubblewrapBackend: RealBackend } = await import("../../sandbox/bubblewrap-backend.js");
    const backend = new RealBackend();
    await backend.prepare({ allowNetwork: true });

    const result = await backend.run("echo hello", {
      cwd: cwd(),
      timeoutMs: 5_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });
});
