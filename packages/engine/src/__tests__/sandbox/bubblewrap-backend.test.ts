import { cwd } from "node:process";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { detectMock } = vi.hoisted(() => ({ detectMock: vi.fn() }));

vi.mock("../../sandbox/bubblewrap-detect.js", () => ({
  detectBwrap: detectMock,
}));

import { BubblewrapBackend, SandboxUnavailableError } from "../../sandbox/bubblewrap-backend.js";
import type { SandboxBackend, SandboxRunResult } from "../../sandbox/types.js";

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
      capabilities: () => ({ id: "native", supportsNetworkPolicy: false, supportsFilesystemPolicy: false, platform: "any" }),
      prepare: vi.fn(async () => undefined),
      run: vi.fn(async () => runResult),
      dispose: vi.fn(async () => undefined),
    };

    const backend = new BubblewrapBackend(nativeStub);
    await backend.prepare({ allowNetwork: true, env: {}, allowedReadPaths: [], allowedWritePaths: [], failureMode: "fallback-native" } as any);

    const result = await backend.run("echo hi", { cwd: cwd(), timeoutMs: 1_000, maxBuffer: 1024, encoding: "utf-8" });
    expect(result.stdout).toBe("native");
    expect(nativeStub.run).toHaveBeenCalled();
  });

  it("attempts bwrap execution when available", async () => {
    detectMock.mockResolvedValue({ available: true, path: "bwrap" });
    const backend = new BubblewrapBackend();
    await backend.prepare({ allowNetwork: true });

    const result = await backend.run("echo hello", {
      cwd: cwd(),
      timeoutMs: 5_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });

    expect(result).toHaveProperty("stdout");
    expect(result).toHaveProperty("stderr");
  });
});
