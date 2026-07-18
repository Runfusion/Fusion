import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildNonFrozenRetryCommand,
  computeLockfileHash,
  installWorktreeDependencies,
  isOutdatedLockfileError,
  readInstallMarker,
} from "../merge-dependency-sync.js";

/*
FNXC:AIMerge 2026-07-02-14:05 (lockfile auto-heal):
Fast unit coverage for the inferred frozen-lockfile → non-frozen retry recovery. A task that adds a
dependency without regenerating the lockfile makes `pnpm install --frozen-lockfile` fail with
ERR_PNPM_OUTDATED_LOCKFILE; the merger must recover by re-running non-frozen instead of aborting the merge.
Uses a fake `pnpm` bin (no git, no runAiMerge) to stay off the slow lane (FN-5048).
*/

const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const tracked = new Set<string>();
afterAll(() => {
  for (const d of tracked) {
    try { rmSync(d, RM); } catch { /* best effort */ }
  }
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tracked.add(dir);
  return dir;
}

/**
 * Install a fake `pnpm` that logs each invocation's args and, when `--frozen-lockfile` is present, exits
 * non-zero with the canonical pnpm outdated-lockfile stderr. `--no-frozen-lockfile` succeeds. Returns the
 * prior PATH so the caller can restore it.
 */
function installFakePnpm(logPath: string): string {
  const binDir = tmp("fusion-heal-fake-bin-");
  const script = join(binDir, "pnpm");
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
if (args.includes('--frozen-lockfile')) {
  process.stderr.write('ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json\\n');
  process.exit(1);
}
process.exit(0);
`,
  );
  chmodSync(script, 0o755);
  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${delimiter}${previousPath}`;
  return previousPath;
}

function readLog(path: string): string[][] {
  return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("buildNonFrozenRetryCommand", () => {
  it("negates pnpm frozen flag explicitly (overrides CI default)", () => {
    expect(buildNonFrozenRetryCommand("pnpm install --frozen-lockfile")).toBe("pnpm install --no-frozen-lockfile");
  });
  it("drops the frozen flag for yarn and bun", () => {
    expect(buildNonFrozenRetryCommand("yarn install --frozen-lockfile")).toBe("yarn install");
    expect(buildNonFrozenRetryCommand("bun install --frozen-lockfile")).toBe("bun install");
  });
  it("returns null when there is no frozen flag to heal", () => {
    expect(buildNonFrozenRetryCommand("npm install")).toBeNull();
    expect(buildNonFrozenRetryCommand("pnpm install")).toBeNull();
  });
});

describe("isOutdatedLockfileError", () => {
  it("matches pnpm/yarn/bun frozen-refusal signatures", () => {
    expect(isOutdatedLockfileError("ERR_PNPM_OUTDATED_LOCKFILE cannot install")).toBe(true);
    expect(isOutdatedLockfileError("Your lockfile needs to be updated")).toBe(true);
    expect(isOutdatedLockfileError("error: lockfile had changes, but lockfile is frozen")).toBe(true);
  });
  it("does not match unrelated install failures", () => {
    expect(isOutdatedLockfileError("ENOTFOUND registry.npmjs.org")).toBe(false);
    expect(isOutdatedLockfileError("EACCES: permission denied")).toBe(false);
  });
});

describe("installWorktreeDependencies lockfile auto-heal", () => {
  it("retries non-frozen and heals when an inferred frozen install hits an outdated lockfile", async () => {
    const dir = tmp("fusion-heal-repo-");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfile: {}\n");
    mkdirSync(join(dir, "node_modules"), { recursive: true }); // a real install creates this; the marker lives under it
    const logPath = join(tmp("fusion-heal-log-"), "install.log");
    const previousPath = installFakePnpm(logPath);
    try {
      const result = await installWorktreeDependencies({ cwd: dir, taskId: "FN-1" });
      expect(result.healed).toBe(true);
      expect(result.healedCommand).toBe("pnpm install --no-frozen-lockfile");
      expect(result.installCommand).toBe("pnpm install --frozen-lockfile");
      expect(result.skipped).toBe(false);
      // Marker reflects the current lockfile so the next merge can legitimately skip when unchanged.
      expect(readInstallMarker(dir)).toBe(computeLockfileHash(dir));
    } finally {
      process.env.PATH = previousPath;
    }

    const calls = readLog(logPath);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["install", "--frozen-lockfile"]);
    expect(calls[1]).toEqual(["install", "--no-frozen-lockfile"]);
  });

  it("does NOT auto-heal a configured worktreeInitCommand — frozen intent is authoritative", async () => {
    const dir = tmp("fusion-heal-configured-");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfile: {}\n");
    const logPath = join(tmp("fusion-heal-log-"), "install.log");
    const previousPath = installFakePnpm(logPath);
    try {
      await expect(
        installWorktreeDependencies({
          cwd: dir,
          taskId: "FN-1",
          settings: { worktreeInitCommand: "pnpm install --frozen-lockfile" } as any,
        }),
      ).rejects.toThrow(/Dependency sync failed for FN-1.*OUTDATED_LOCKFILE/);
    } finally {
      process.env.PATH = previousPath;
    }
    // Only the single frozen attempt ran; no non-frozen retry.
    expect(readLog(logPath)).toEqual([["install", "--frozen-lockfile"]]);
  });
});

/*
FNXC:MergeDeps 2026-07-17-12:00:
Env passthrough coverage for installWorktreeDependencies. The explicit forwarding of corepack/pnpm
env vars mirrors mission-verification.ts VERIFICATION_ENV_ALLOWLIST so pnpm is resolvable even when
the engine process starts without full shell initialization.
*/
describe("installWorktreeDependencies env passthrough", () => {
  /**
   * Install a fake `pnpm` that logs selected env vars to a file so we can assert
   * the child process receives the expected environment. Writes a JSON object with
   * the requested env var values.
   */
  function installEnvLoggingPnpm(envVars: string[], logPath: string): string {
    const binDir = tmp("fusion-env-fake-bin-");
    const script = join(binDir, "pnpm");
    const varsJson = JSON.stringify(envVars);
    writeFileSync(
      script,
      `#!/usr/bin/env node
const fs = require('fs');
const vars = ${varsJson};
const env = {};
for (let v of vars) env[v] = process.env[v];
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(env));
`,
    );
    chmodSync(script, 0o755);
    const previousPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}${delimiter}${previousPath}`;
    return previousPath;
  }

  it("passes COREPACK_HOME, PNPM_HOME, and npm_config_registry through to exec", async () => {
    // Set the env vars so the passthrough has values to forward
    const origCorepackHome = process.env.COREPACK_HOME;
    const origPnpmHome = process.env.PNPM_HOME;
    const origNpmRegistry = process.env.npm_config_registry;
    process.env.COREPACK_HOME = "/tmp/fake-corepack";
    process.env.PNPM_HOME = "/tmp/fake-pnpm";
    process.env.npm_config_registry = "https://fake.registry/";

    const dir = tmp("fusion-env-repo-");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfile: {}\n");

    const logPath = join(tmp("fusion-env-log-"), "env.json");
    const previousPath = installEnvLoggingPnpm(
      ["COREPACK_HOME", "PNPM_HOME", "npm_config_registry"],
      logPath,
    );
    try {
      await installWorktreeDependencies({ cwd: dir, taskId: "FN-1" });

      const captured = JSON.parse(readFileSync(logPath, "utf-8"));
      expect(captured.COREPACK_HOME).toBe("/tmp/fake-corepack");
      expect(captured.PNPM_HOME).toBe("/tmp/fake-pnpm");
      expect(captured.npm_config_registry).toBe("https://fake.registry/");
    } finally {
      process.env.PATH = previousPath;
      process.env.COREPACK_HOME = origCorepackHome;
      process.env.PNPM_HOME = origPnpmHome;
      process.env.npm_config_registry = origNpmRegistry;
    }
  });

  it("does NOT override or strip existing env vars like PATH", async () => {
    const dir = tmp("fusion-env-repo2-");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfile: {}\n");

    const logPath = join(tmp("fusion-env-log2-"), "env.json");
    const previousPath = installEnvLoggingPnpm(
      ["PATH", "HOME", "SHELL"],
      logPath,
    );
    try {
      await installWorktreeDependencies({ cwd: dir, taskId: "FN-1" });

      const captured = JSON.parse(readFileSync(logPath, "utf-8"));
      // PATH should still contain the fake bin dir AND the real PATH
      expect(captured.PATH).toContain("fusion-env-fake-bin-");
      // HOME and SHELL should be preserved from process.env
      expect(captured.HOME).toBe(process.env.HOME);
      expect(captured.SHELL).toBe(process.env.SHELL);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("handles undefined corepack/pnpm env vars gracefully", async () => {
    // Clear the env vars
    const origCorepackHome = process.env.COREPACK_HOME;
    const origPnpmHome = process.env.PNPM_HOME;
    const origNpmRegistry = process.env.npm_config_registry;
    delete process.env.COREPACK_HOME;
    delete process.env.PNPM_HOME;
    delete process.env.npm_config_registry;

    const dir = tmp("fusion-env-repo3-");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfile: {}\n");

    const logPath = join(tmp("fusion-env-log3-"), "env.json");
    const previousPath = installEnvLoggingPnpm(
      ["COREPACK_HOME", "PNPM_HOME", "npm_config_registry", "PATH"],
      logPath,
    );
    try {
      await installWorktreeDependencies({ cwd: dir, taskId: "FN-1" });

      const captured = JSON.parse(readFileSync(logPath, "utf-8"));
      // When the env vars are undefined, they should be undefined in the child too
      // (not set to empty string or some sentinel)
      expect(captured.COREPACK_HOME).toBeUndefined();
      expect(captured.PNPM_HOME).toBeUndefined();
      expect(captured.npm_config_registry).toBeUndefined();
      // PATH should still be present
      expect(captured.PATH).toBeDefined();
    } finally {
      process.env.PATH = previousPath;
      process.env.COREPACK_HOME = origCorepackHome;
      process.env.PNPM_HOME = origPnpmHome;
      process.env.npm_config_registry = origNpmRegistry;
    }
  });
});
