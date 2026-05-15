import { cwd } from "node:process";

import { describe, expect, it } from "vitest";

import { NativeSandboxBackend } from "../native.js";

describe("NativeSandboxBackend", () => {
  it("returns stdout on success", async () => {
    const backend = new NativeSandboxBackend();
    const result = await backend.run("node -e 'process.stdout.write(\"ok\")'", {
      cwd: cwd(),
      timeoutMs: 5_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.timedOut).toBe(false);
    expect(result.bufferExceeded).toBe(false);
  });

  it("maps timeout failures", async () => {
    const backend = new NativeSandboxBackend();
    const result = await backend.run("node -e 'setTimeout(() => {}, 1000)'", {
      cwd: cwd(),
      timeoutMs: 50,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGTERM");
  });

  it("maps non-zero exits", async () => {
    const backend = new NativeSandboxBackend();
    const result = await backend.run("node -e 'process.stderr.write(\"fail\"); process.exit(7)'", {
      cwd: cwd(),
      timeoutMs: 5_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("fail");
    expect(result.timedOut).toBe(false);
  });

  it("maps maxBuffer failures", async () => {
    const backend = new NativeSandboxBackend();
    const result = await backend.run("node -e 'process.stdout.write(\"x\".repeat(5000))'", {
      cwd: cwd(),
      timeoutMs: 5_000,
      maxBuffer: 512,
      encoding: "utf-8",
    });

    expect(result.bufferExceeded).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("prepare/dispose are idempotent no-ops", async () => {
    const backend = new NativeSandboxBackend();

    await expect(backend.prepare({ allowNetwork: true })).resolves.toBeUndefined();
    await expect(backend.prepare({ allowNetwork: false })).resolves.toBeUndefined();
    await expect(backend.dispose()).resolves.toBeUndefined();
    await expect(backend.dispose()).resolves.toBeUndefined();
  });
});
