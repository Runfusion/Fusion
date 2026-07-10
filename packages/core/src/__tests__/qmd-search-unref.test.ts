/**
 * FNXC:ProjectMemory 2026-07-08-00:00:
 * Regression coverage for FN-7707: the AWAITED `searchWithQmd` search child spawned
 * by memory-backend.ts must route through the FN-7706-hardened, unref'd default
 * executor (getDefaultExecFileAsync) instead of carrying its own inline
 * `promisify(execFile)` copy, so a short-lived caller invoking a project-memory
 * search never gets held open by the qmd child's stdio pipes beyond its own actual
 * work. Two layers:
 *  1. A unit test asserting `searchWithQmd` routes both the collection-add and the
 *     search call through the default executor (no private promisify(execFile)).
 *  2. An end-to-end symptom test: a fixture Node process awaits a search against a
 *     slow, SIGTERM-ignoring fake `qmd` stub on PATH and must still exit well
 *     before the stub's own runtime completes.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const tsxPackageJsonPath = createRequire(import.meta.url).resolve("tsx/package.json");
const tsxCliPath = join(tsxPackageJsonPath, "..", "dist", "cli.mjs");

describe("searchWithQmd routes through the hardened default executor (unit)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("calls the default (spawn-based) executor for both collection-add and search, never a private promisify(execFile)", async () => {
    vi.stubEnv("FUSION_ENABLE_QMD_REFRESH_IN_TESTS", "1");
    vi.resetModules();

    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: (file: string, args: string[], options: unknown) => {
          spawnCalls.push({ file, args });
          const lastArg = Array.isArray(args) ? args[0] : undefined;
          // Fake a fast-closing child for both "collection"/"add" and "search".
          const fakeChild = actual.spawn(
            process.execPath,
            ["-e", lastArg === "search" ? "process.stdout.write('[]')" : ""],
            options as Record<string, unknown>,
          );
          return fakeChild;
        },
      };
    });

    const rootDir = mkdtempSync(join(tmpdir(), "fn-7707-unit-root-"));
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, ".fusion", "memory"), { recursive: true });

    const { QmdMemoryBackend } = await import("../memory-backend.js");
    const backend = new QmdMemoryBackend();
    const results = await backend.search(rootDir, { query: "unit-test-query", limit: 5 });

    expect(Array.isArray(results)).toBe(true);
    // Both the collection-add and the qmd search calls must go through the mocked
    // `spawn` (the default executor's underlying primitive) — proving searchWithQmd
    // no longer constructs its own private `promisify(execFile)` copy, which would
    // bypass this mock entirely and use the real un-unref'd execFile path instead.
    const collectionAddCalls = spawnCalls.filter((call) => call.args[0] === "collection" && call.args[1] === "add");
    const searchCalls = spawnCalls.filter((call) => call.args[0] === "search");
    expect(collectionAddCalls.length).toBeGreaterThanOrEqual(1);
    expect(searchCalls.length).toBeGreaterThanOrEqual(1);

    vi.doUnmock("node:child_process");
  });
});

describe("qmd search does not keep a short-lived caller alive (symptom)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeStubbornSlowQmdStub(stubDir: string): void {
    // Fake `qmd`: "collection add" (and anything else) responds instantly.
    // "search" traps and ignores SIGTERM, then sleeps ~8s before responding — this
    // models a qmd child that keeps running past searchWithQmd's own 4s internal
    // timeout kill attempt, so only a properly unref'd child+stdio (not a merely
    // "timed-out" JS promise) lets the caller process exit promptly.
    const stubPath = join(stubDir, "qmd");
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env bash",
        "trap '' TERM",
        'case "$1" in',
        "  search)",
        "    sleep 8",
        "    echo '[]'",
        "    ;;",
        "  *)",
        "    exit 0",
        "    ;;",
        "esac",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(stubPath, 0o755);
  }

  async function runFixture(rootDir: string, stubDir: string) {
    const fixturePath = join(import.meta.dirname, "fixtures", "qmd-search-fixture.mjs");
    const startedAt = Date.now();
    return new Promise<{ code: number | null; elapsedMs: number; stdout: string }>((resolvePromise, reject) => {
      let stdout = "";
      const child = spawn(process.execPath, [tsxCliPath, fixturePath, rootDir], {
        env: {
          ...process.env,
          PATH: `${stubDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
          FUSION_ENABLE_QMD_REFRESH_IN_TESTS: "1",
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

  it("search: fixture process exits promptly even though the search's qmd child ignores the internal timeout kill and keeps sleeping", async () => {
    const stubDir = mkdtempSync(join(tmpdir(), "fn-7707-qmd-stub-"));
    tempDirs.push(stubDir);
    const rootDir = mkdtempSync(join(tmpdir(), "fn-7707-qmd-root-"));
    tempDirs.push(rootDir);
    writeStubbornSlowQmdStub(stubDir);

    const exitInfo = await runFixture(rootDir, stubDir);

    expect(exitInfo.stdout).toContain("qmd-search-fixture:started");
    // Once the search's child + stdio are properly unref'd, nothing else keeps the
    // fixture's event loop alive, so Node exits promptly with the still-pending
    // top-level `await backend.search(...)` abandoned — Node reports this as exit
    // code 13 ("unsettled top-level await"), which is expected/desired here: it is
    // direct proof the process did NOT wait for the SIGTERM-ignoring qmd child.
    // What matters is that the process exits at all (is not null/hung) and does so
    // well before the stub's 8s sleep completes.
    expect(exitInfo.code).not.toBeNull();
    // The stub ignores SIGTERM and only responds to "search" after an 8s sleep; the
    // fixture process must exit well before that, proving the search's child +
    // stdio were unref'd rather than holding the fixture's event loop open for the
    // child's full runtime after its own work (spawning + collection-add) is done.
    expect(exitInfo.elapsedMs).toBeLessThan(5_000);
  }, 15_000);
});
