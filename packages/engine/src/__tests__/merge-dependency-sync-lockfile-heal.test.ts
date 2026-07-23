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
} from "../merge/merge-dependency-sync.js";

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
