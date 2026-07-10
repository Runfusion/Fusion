/**
 * FNXC:ProjectMemory 2026-07-08-00:00:
 * Regression coverage for FN-7706: the background qmd child spawned by the default
 * (real) exec path in memory-backend.ts must be unref'd (child + stdio) so a
 * short-lived caller can exit promptly, while a long-lived caller that stays alive
 * anyway still sees the refresh complete. Two layers:
 *  1. A fast unit test on the extracted `unrefQmdChildProcess` helper (no real spawn).
 *  2. An end-to-end symptom test: a fixture Node process fires a background refresh
 *     against a slow fake `qmd` stub on PATH and must exit well before the stub does.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { unrefQmdChildProcess } from "../memory-backend.js";

const tsxPackageJsonPath = createRequire(import.meta.url).resolve("tsx/package.json");
const tsxCliPath = join(tsxPackageJsonPath, "..", "dist", "cli.mjs");

describe("unrefQmdChildProcess (unit)", () => {
  it("unrefs the child process and its stdout/stderr/stdin pipes", () => {
    const calls: string[] = [];
    const fakeChild = {
      unref: () => calls.push("child"),
      stdout: { unref: () => calls.push("stdout") },
      stderr: { unref: () => calls.push("stderr") },
      stdin: { unref: () => calls.push("stdin") },
    };

    unrefQmdChildProcess(fakeChild);

    expect(calls.sort()).toEqual(["child", "stderr", "stdin", "stdout"]);
  });

  it("tolerates a missing child or missing stdio streams without throwing", () => {
    expect(() => unrefQmdChildProcess(undefined)).not.toThrow();
    expect(() => unrefQmdChildProcess(null)).not.toThrow();
    expect(() => unrefQmdChildProcess({})).not.toThrow();
    expect(() =>
      unrefQmdChildProcess({ unref: () => {}, stdout: null, stderr: null, stdin: null }),
    ).not.toThrow();
  });
});

describe("qmd background refresh does not keep a short-lived caller alive (symptom)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeSlowQmdStub(stubDir: string): void {
    // Fake `qmd`: resolves instantly for "collection add", but sleeps well past our
    // exit-bound assertion for "update"/"embed" — this models the real symptom
    // (long-sleeping qmd child) without a real multi-second wait dominating the test
    // budget on the assertion side; only the *stub* sleeps long, the *test* just
    // measures how fast the fixture process exits.
    const stubPath = join(stubDir, "qmd");
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env bash",
        'case "$1" in',
        "  update|embed)",
        "    sleep 8",
        "    ;;",
        "esac",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(stubPath, 0o755);
  }

  async function runFixture(mode: "project" | "agent", rootDir: string, stubDir: string) {
    const fixturePath = join(import.meta.dirname, "fixtures", "qmd-refresh-fixture.mjs");
    const startedAt = Date.now();
    return new Promise<{ code: number | null; elapsedMs: number; stdout: string }>((resolvePromise, reject) => {
      let stdout = "";
      const child = spawn(process.execPath, [tsxCliPath, fixturePath, rootDir, mode], {
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

  it("project refresh: fixture process exits promptly even though the background qmd stub is still sleeping", async () => {
    const stubDir = mkdtempSync(join(tmpdir(), "fn-7706-qmd-stub-"));
    tempDirs.push(stubDir);
    const rootDir = mkdtempSync(join(tmpdir(), "fn-7706-qmd-root-"));
    tempDirs.push(rootDir);
    writeSlowQmdStub(stubDir);

    const exitInfo = await runFixture("project", rootDir, stubDir);

    expect(exitInfo.stdout).toContain("qmd-refresh-fixture:scheduled");
    expect(exitInfo.code).toBe(0);
    // The fake qmd sleeps 8s on "update"/"embed"; the fixture process must exit
    // well before that, proving the background child + stdio were unref'd rather
    // than holding the fixture's event loop open for the qmd child's full runtime.
    expect(exitInfo.elapsedMs).toBeLessThan(5_000);
  }, 15_000);

  it("agent refresh: fixture process exits promptly even though the background qmd stub is still sleeping", async () => {
    const stubDir = mkdtempSync(join(tmpdir(), "fn-7706-qmd-agent-stub-"));
    tempDirs.push(stubDir);
    const rootDir = mkdtempSync(join(tmpdir(), "fn-7706-qmd-agent-root-"));
    tempDirs.push(rootDir);
    writeSlowQmdStub(stubDir);

    const exitInfo = await runFixture("agent", rootDir, stubDir);

    expect(exitInfo.stdout).toContain("qmd-refresh-fixture:scheduled");
    expect(exitInfo.code).toBe(0);
    // refreshQmdAgentMemoryIndex routes through the same default executor as the
    // project path; this proves the agent surface inherits the unref fix too.
    expect(exitInfo.elapsedMs).toBeLessThan(5_000);
  }, 15_000);
});
