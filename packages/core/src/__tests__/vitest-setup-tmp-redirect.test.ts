import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __fusionTmpdirRedirectTestHooks } from "../__test-utils__/vitest-setup";
import { DatabaseSync } from "../db/sqlite-adapter.js";

const createdPaths: string[] = [];

function remember(path: string): string {
  createdPaths.push(path);
  return path;
}

function expectUnderWorkerRoot(path: string): void {
  const workerRoot = process.env.FUSION_TEST_WORKER_ROOT;
  expect(workerRoot).toBeTruthy();
  expect(path.startsWith(`${workerRoot}${sep}`)).toBe(true);
  expect(dirname(path)).toBe(join(workerRoot!, `redir-${process.pid}`));
}

function rememberDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return remember(path);
}

afterEach(() => {
  for (const path of createdPaths.splice(0).reverse()) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("vitest setup tmpdir mkdtemp redirect", () => {
  it("redirects sync mkdtemp prefixes rooted directly at the OS temp dir", () => {
    const path = remember(mkdtempSync(join(tmpdir(), "fn-redirect-sync-")));

    expectUnderWorkerRoot(path);
  });

  it("redirects async mkdtemp prefixes rooted directly at the OS temp dir", async () => {
    const path = remember(await mkdtemp(join(tmpdir(), "fn-redirect-async-")));

    expectUnderWorkerRoot(path);
  });

  it("redirects the realpath spelling of the OS temp dir when it differs", () => {
    const realTmpdir = realpathSync(tmpdir());
    if (realTmpdir === tmpdir()) {
      expect(realTmpdir).toBe(tmpdir());
      return;
    }

    const path = remember(mkdtempSync(join(realTmpdir, "fn-redirect-realpath-")));

    expectUnderWorkerRoot(path);
  });

  it("leaves nested temp-root prefixes unchanged", () => {
    const parent = remember(join(tmpdir(), `fn-redirect-parent-${process.pid}-${Date.now()}`));
    mkdirSync(parent, { recursive: true });

    const path = remember(mkdtempSync(join(parent, "nested-")));

    expect(path.startsWith(`${parent}${sep}`)).toBe(true);
  });

  it("leaves non-string prefixes untouched", () => {
    const prefix = Buffer.from(join(tmpdir(), "fn-redirect-buffer-"));

    const path = remember(mkdtempSync(prefix));

    expect(path.startsWith(`${tmpdir()}${sep}`)).toBe(true);
  });

  it("recreates the cached redirect sink after deletion for sync and async mkdtemp", async () => {
    const sink = __fusionTmpdirRedirectTestHooks.sinkForPid(process.pid);
    const first = remember(mkdtempSync(join(tmpdir(), "fn-redirect-prime-")));
    expectUnderWorkerRoot(first);
    expect(existsSync(sink)).toBe(true);

    rmSync(sink, { recursive: true, force: true });
    expect(existsSync(sink)).toBe(false);

    const syncPath = remember(mkdtempSync(join(tmpdir(), "fn-redirect-recreated-sync-")));
    expect(existsSync(syncPath)).toBe(true);
    expect(dirname(syncPath)).toBe(sink);
    expect(existsSync(sink)).toBe(true);

    rmSync(sink, { recursive: true, force: true });
    expect(existsSync(sink)).toBe(false);

    const asyncPath = remember(await mkdtemp(join(tmpdir(), "fn-redirect-recreated-async-")));
    expect(existsSync(asyncPath)).toBe(true);
    expect(dirname(asyncPath)).toBe(sink);
    expect(existsSync(sink)).toBe(true);
  });

  it("revalidates cwd, HOME, tmpdir redirect, and SQLite opens after mid-run cleanup", () => {
    const originalHome = process.env.HOME;
    expect(originalHome).toBeTruthy();
    expect(existsSync(originalHome!)).toBe(true);

    const sink = __fusionTmpdirRedirectTestHooks.sinkForPid(process.pid);
    const doomedCwd = remember(mkdtempSync(join(tmpdir(), "fn-redirect-cwd-")));
    process.chdir(doomedCwd);
    rmSync(sink, { recursive: true, force: true });
    rmSync(originalHome!, { recursive: true, force: true });
    expect(existsSync(sink)).toBe(false);
    expect(existsSync(originalHome!)).toBe(false);

    const sqliteProject = remember(mkdtempSync(join(tmpdir(), "fn-redirect-sqlite-")));
    const fusionDir = join(sqliteProject, ".fusion");
    mkdirSync(fusionDir, { recursive: true });
    const db = new DatabaseSync(join(fusionDir, "fusion.db"));
    db.exec("CREATE TABLE smoke (id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO smoke (id) VALUES (?)").run("ok");
    expect(db.prepare("SELECT id FROM smoke").get()).toEqual({ id: "ok" });
    db.close();

    const output = execSync("git config --global user.name fusion-test && git config --global --get user.name && pwd", { encoding: "utf8" });

    expect(output).toContain("fusion-test");
    expect(output).toContain(process.env.FUSION_TEST_WORKER_ROOT!);
    expect(process.env.HOME).toBe(originalHome);
    expect(existsSync(process.env.HOME!)).toBe(true);
    expect(existsSync(sink)).toBe(true);
  });

  it("sweeps only dead redirect sinks and preserves current or alive pids", () => {
    const { registryPath, resetSweepForTest, sinkForPid, sweepDeadTmpdirRedirectSinks } = __fusionTmpdirRedirectTestHooks;
    const currentSink = rememberDir(sinkForPid(process.pid));
    const liveForeignPid = process.ppid;
    const liveForeignSink = rememberDir(sinkForPid(liveForeignPid));
    const deadPid = 99_999_999;
    const deadSink = rememberDir(sinkForPid(deadPid));

    writeFileSync(registryPath, `${process.pid}\n${process.pid}\n${liveForeignPid}\n${deadPid}\n`);
    resetSweepForTest();
    sweepDeadTmpdirRedirectSinks();

    expect(existsSync(currentSink)).toBe(true);
    expect(existsSync(liveForeignSink)).toBe(true);
    expect(existsSync(deadSink)).toBe(false);

    const fallbackDeadSink = rememberDir(sinkForPid(deadPid - 1));
    rmSync(registryPath, { force: true });
    resetSweepForTest();
    sweepDeadTmpdirRedirectSinks();

    expect(existsSync(currentSink)).toBe(true);
    expect(existsSync(liveForeignSink)).toBe(true);
    expect(existsSync(fallbackDeadSink)).toBe(false);

    const emptyRegistryDeadSink = rememberDir(sinkForPid(deadPid - 2));
    writeFileSync(registryPath, "");
    resetSweepForTest();
    sweepDeadTmpdirRedirectSinks();

    expect(existsSync(currentSink)).toBe(true);
    expect(existsSync(liveForeignSink)).toBe(true);
    expect(existsSync(emptyRegistryDeadSink)).toBe(false);
  });
});
