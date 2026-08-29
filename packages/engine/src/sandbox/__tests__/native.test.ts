import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd } from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NativeSandboxBackend } from "../native.js";

describe("NativeSandboxBackend", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fusion-native-sandbox-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

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

  it.skipIf(process.platform === "win32")("times out and terminates descendant processes in the command process group", async () => {
    const backend = new NativeSandboxBackend();
    const markerPath = join(tempDir, "descendant-survived.txt");
    const parentScriptPath = join(tempDir, "spawn-descendant.cjs");
    await writeFile(
      parentScriptPath,
      `
const { spawn } = require("node:child_process");
spawn(process.execPath, [
  "-e",
  "setTimeout(() => require('node:fs').writeFileSync(process.env.MARKER, 'survived'), 450)",
], {
  env: { ...process.env, MARKER: process.argv[2] },
  stdio: "ignore",
}).unref();
setInterval(() => {}, 1000);
`,
      "utf-8",
    );

    const result = await backend.run(
      `${JSON.stringify(process.execPath)} ${JSON.stringify(parentScriptPath)} ${JSON.stringify(markerPath)}`,
      {
        cwd: tempDir,
        timeoutMs: 75,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
      },
    );

    expect(result.timedOut).toBe(true);
    await delay(700);
    await expect(access(markerPath)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("cleans up background children after successful commands", async () => {
    const backend = new NativeSandboxBackend();
    const markerPath = join(tempDir, "success-descendant-survived.txt");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify("setTimeout(() => require('node:fs').writeFileSync(process.env.MARKER, 'survived'), 450)")}], { env: { ...process.env, MARKER: process.env.MARKER }, stdio: 'ignore' }).unref();`,
      "process.stdout.write('parent-done');",
    ].join(" ");

    const result = await backend.run(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(parentScript)}`,
      {
        cwd: tempDir,
        timeoutMs: 5_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
        env: { ...process.env, MARKER: markerPath },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("parent-done");
    await delay(700);
    await expect(access(markerPath)).rejects.toThrow();
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
