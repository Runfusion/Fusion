import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireEngineSingleton,
  computeEngineLockFilePath,
  computeEngineSocketPath,
  EngineAlreadyRunningError,
  type EngineSingletonLock,
} from "../project/engine-singleton-lock.js";

function uniqueProjectId(label: string): string {
  return `proj_${label}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe("engine-singleton-lock", () => {
  let workDir: string;
  let acquired: EngineSingletonLock[] = [];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "fusion-engine-lock-test-"));
    acquired = [];
  });

  afterEach(async () => {
    for (const lock of acquired) {
      await lock.release().catch(() => {});
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it("computes a deterministic socket path per projectId", () => {
    const id = "proj_deterministic";
    expect(computeEngineSocketPath(id)).toBe(computeEngineSocketPath(id));
    expect(computeEngineSocketPath(id)).not.toBe(
      computeEngineSocketPath("proj_other"),
    );
  });

  it("places the lockfile under <workingDir>/.fusion/engine.lock", () => {
    expect(computeEngineLockFilePath(workDir)).toBe(
      join(workDir, ".fusion", "engine.lock"),
    );
  });

  it("acquires successfully on first call and creates .fusion/engine.lock", async () => {
    const id = uniqueProjectId("first");
    const lock = await acquireEngineSingleton(id, workDir);
    acquired.push(lock);
    expect(existsSync(lock.lockFilePath)).toBe(true);
  });

  it("rejects a second acquisition for the same project + workingDir", async () => {
    const id = uniqueProjectId("double");
    const first = await acquireEngineSingleton(id, workDir);
    acquired.push(first);
    await expect(acquireEngineSingleton(id, workDir)).rejects.toBeInstanceOf(
      EngineAlreadyRunningError,
    );
  });

  it("allows re-acquisition after release", async () => {
    const id = uniqueProjectId("cycle");
    const first = await acquireEngineSingleton(id, workDir);
    await first.release();
    // Double-release must be a no-op.
    await first.release();

    const second = await acquireEngineSingleton(id, workDir);
    acquired.push(second);
    expect(existsSync(second.lockFilePath)).toBe(true);
  });

  it("recovers from a stale socket file (POSIX only)", async () => {
    if (platform() === "win32") return;

    const id = uniqueProjectId("stale");
    const socketPath = computeEngineSocketPath(id);

    // Simulate a stale socket file from a crashed engine.
    const stale = net.createServer();
    stale.unref();
    await new Promise<void>((resolve, reject) => {
      stale.once("error", reject);
      stale.once("listening", () => resolve());
      stale.listen(socketPath);
    });
    await new Promise<void>((resolve) => stale.close(() => resolve()));

    const lock = await acquireEngineSingleton(id, workDir);
    acquired.push(lock);
    expect(existsSync(lock.lockFilePath)).toBe(true);
  });

  it("releases the lockfile so a fresh process could re-acquire", async () => {
    const id = uniqueProjectId("release-lockfile");
    const lock = await acquireEngineSingleton(id, workDir);
    await lock.release();
    // proper-lockfile uses `<path>.lock` as the actual mutex dir.
    expect(existsSync(`${lock.lockFilePath}.lock`)).toBe(false);
  });

  it("different projects don't block each other", async () => {
    const a = await acquireEngineSingleton(uniqueProjectId("a"), workDir);
    acquired.push(a);
    const otherWork = mkdtempSync(join(tmpdir(), "fusion-engine-lock-test-b-"));
    try {
      const b = await acquireEngineSingleton(uniqueProjectId("b"), otherWork);
      acquired.push(b);
      expect(existsSync(a.lockFilePath)).toBe(true);
      expect(existsSync(b.lockFilePath)).toBe(true);
    } finally {
      rmSync(otherWork, { recursive: true, force: true });
    }
  });
});
