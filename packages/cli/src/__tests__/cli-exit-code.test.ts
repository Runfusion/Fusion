import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspaceRoot = join(import.meta.dirname, "..", "..", "..", "..");
const cliBin = join(workspaceRoot, "packages", "cli", "bin.mjs");
const builtEntry = join(workspaceRoot, "packages", "cli", "dist", "bin.js");
const tempDirs: string[] = [];
const isolatedHome = mkdtempSync(join(tmpdir(), "fn-cli-exit-home-"));
tempDirs.push(isolatedHome);

function runCli(args: string[]) {
  const {
    DATABASE_URL: _databaseUrl,
    FUSION_NO_EMBEDDED_PG: _noEmbeddedPg,
    NODE_ENV: _nodeEnv,
    VITEST: _vitest,
    ...env
  } = process.env;
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd: workspaceRoot,
    env: {
      ...env,
      HOME: isolatedHome,
      /*
       * FNXC:CliAwaitLiveness 2026-08-11-09:30:
       * The subprocess must be production-shaped: inherited Vitest markers reject
       * implicit global config directories before CentralCore can initialize.
       */
      NODE_ENV: "production",
      VITEST: undefined,
    },
    encoding: "utf8",
    timeout: 180_000,
  });
  expect(result.error, `CLI timed out or could not start: ${result.stderr}`).toBeUndefined();
  expect(result.stderr).not.toMatch(/Detected unsettled top-level await/);
  return result;
}

function expectSuccessfulExit(result: ReturnType<typeof runCli>): void {
  expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
}

afterAll(() => {
  for (const path of tempDirs) rmSync(path, { recursive: true, force: true });
});

/*
 * FNXC:CliAwaitLiveness 2026-08-11-09:17:
 * This uses the built launcher in a real isolated process because Node's exit-13
 * unsettled-top-level-await path cannot be reproduced by mocked in-process init.
 * One HOME shares the cold embedded-PostgreSQL initialization across every surface.
 */
describe.skipIf(!existsSync(builtEntry))("built CLI completion", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fn-cli-exit-project-"));
  tempDirs.push(projectDir);

  it("keeps the help fast path successful", () => {
    expectSuccessfulExit(runCli(["--help"]));
  }, 180_000);

  it("completes init, persists the project marker, and does not exit 13", () => {
    const result = runCli(["init", "--name", "exit-code-repro", "--path", projectDir]);
    expectSuccessfulExit(result);
    expect(result.status).not.toBe(13);

    const identityPath = join(projectDir, ".fusion", "project.json");
    expect(existsSync(identityPath)).toBe(true);
    expect(JSON.parse(readFileSync(identityPath, "utf8"))).toMatchObject({ id: expect.any(String) });
  }, 180_000);

  it("lets project list and idempotent re-init complete with the marker preserved", () => {
    expectSuccessfulExit(runCli(["project", "list"]));
    expectSuccessfulExit(runCli(["init", "--name", "exit-code-repro", "--path", projectDir]));
    expect(JSON.parse(readFileSync(join(projectDir, ".fusion", "project.json"), "utf8"))).toMatchObject({
      id: expect.any(String),
    });
  }, 180_000);
});
