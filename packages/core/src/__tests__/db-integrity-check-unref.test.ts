/**
 * FNXC:Database 2026-07-08-00:00:
 * Regression coverage for FN-7709: the background sqlite3 integrity-check child
 * spawned by `integrityCheckSqliteFileAsync` (reached fire-and-forget from
 * `scheduleBackgroundIntegrityCheck`) must be unref'd (child + stdio), and the
 * 60s scheduling `setTimeout` in `scheduleBackgroundIntegrityCheck` must be
 * `.unref()`'d, so a short-lived caller (e.g. a `fn` one-shot CLI command that
 * opens a disk-backed `Database` and exits without `close()`) is not pinned
 * alive by either handle. Two layers, per FN-5048 (prefer bounded
 * fixtures/fake timers over real multi-second waits):
 *  1. A fast fake-timer unit test asserting the 60s scheduling timer is
 *     unref'd (`Timeout#hasRef()`) immediately after `init()` schedules it —
 *     no real 60s wait.
 *  2. An end-to-end symptom test: a fixture Node process fires
 *     `integrityCheckSqliteFileAsync` (fire-and-forget, mirroring the real
 *     call site) against a slow fake `sqlite3` stub on PATH and must exit
 *     well before the stub does.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Database } from "../db.js";

const tsxPackageJsonPath = createRequire(import.meta.url).resolve("tsx/package.json");
const tsxCliPath = join(tsxPackageJsonPath, "..", "dist", "cli.mjs");

describe("scheduleBackgroundIntegrityCheck 60s timer is unref'd (unit)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the shared scheduling timer is unref'd right after init() so it can't pin a short-lived caller alive", () => {
    vi.useFakeTimers();
    try {
      const freshDir = mkdtempSync(join(tmpdir(), "fn-7709-db-unref-"));
      tempDirs.push(freshDir);
      const freshFusionDir = join(freshDir, ".fusion");
      const freshDb = new Database(freshFusionDir);

      try {
        freshDb.init();

        const shared = (
          Database as unknown as {
            sharedIntegrityChecks: Map<string, { timer: { hasRef?: () => boolean } | null }>;
          }
        ).sharedIntegrityChecks.get((freshDb as unknown as { dbPath: string }).dbPath);

        expect(shared?.timer).toBeTruthy();
        // A ref'd (default) Node Timeout reports hasRef() === true; our fix must
        // flip this to false immediately after scheduling, without waiting for
        // the 60s delay to elapse.
        expect(shared?.timer?.hasRef?.()).toBe(false);
      } finally {
        freshDb.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("integrityCheckSqliteFileAsync does not keep a short-lived caller alive (symptom)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeSlowSqlite3Stub(stubDir: string): void {
    // Fake `sqlite3`: sleeps well past our exit-bound assertion regardless of
    // args — models a disk-stalled / slow integrity-check walk without a real
    // multi-second wait dominating the test budget on the assertion side; only
    // the *stub* sleeps long, the *test* just measures how fast the fixture
    // process exits.
    const stubPath = join(stubDir, "sqlite3");
    writeFileSync(stubPath, ["#!/usr/bin/env bash", "sleep 8", "exit 0", ""].join("\n"), "utf8");
    chmodSync(stubPath, 0o755);
  }

  async function runFixture(dbPath: string, stubDir: string) {
    const fixturePath = join(import.meta.dirname, "fixtures", "db-integrity-check-fixture.mjs");
    const startedAt = Date.now();
    return new Promise<{ code: number | null; elapsedMs: number; stdout: string }>((resolvePromise, reject) => {
      let stdout = "";
      const child = spawn(process.execPath, [tsxCliPath, fixturePath, dbPath], {
        env: {
          ...process.env,
          PATH: `${stubDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        resolvePromise({ code, elapsedMs: Date.now() - startedAt, stdout });
      });
    });
  }

  it("fixture process exits promptly even though the background sqlite3 stub is still sleeping", async () => {
    const stubDir = mkdtempSync(join(tmpdir(), "fn-7709-sqlite3-stub-"));
    tempDirs.push(stubDir);
    const rootDir = mkdtempSync(join(tmpdir(), "fn-7709-sqlite3-root-"));
    tempDirs.push(rootDir);
    writeSlowSqlite3Stub(stubDir);

    // integrityCheckSqliteFileAsync only requires the path to exist — an empty
    // file is enough since the real check never runs (the stub short-circuits
    // it) and we only assert on process exit timing here.
    const dbPath = join(rootDir, "fusion.db");
    closeSync(openSync(dbPath, "w"));

    const exitInfo = await runFixture(dbPath, stubDir);

    expect(exitInfo.stdout).toContain("db-integrity-check-fixture:scheduled");
    expect(exitInfo.code).toBe(0);
    // The fake sqlite3 sleeps 8s; the fixture process must exit well before
    // that, proving the background child + stdio were unref'd rather than
    // holding the fixture's event loop open for the stub's full runtime.
    expect(exitInfo.elapsedMs).toBeLessThan(5_000);
  }, 15_000);
});
