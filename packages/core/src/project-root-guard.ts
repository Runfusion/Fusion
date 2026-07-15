/**
 * Guard helpers for store constructors that expect a project root and append
 * `.fusion` internally. Passing an existing `.fusion` directory produces the
 * nested `.fusion/.fusion` tree we want to fail loudly on.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PROJECT_IDENTITY_FILENAME } from "./project-identity.js";

const FUSION_DIR_SUFFIX = /(?:^|[\\/])\.fusion(?:[\\/])?$/;

/**
 * FNXC:PostgresProjectDiscovery 2026-07-14-17:30:
 * The PostgreSQL-era project marker protects linked worktrees from accidental
 * nested initialization. `fusion.db` remains a legacy signal only.
 */
function hasFusionProjectSignal(rootDir: string): boolean {
  return existsSync(join(rootDir, ".fusion", PROJECT_IDENTITY_FILENAME))
    || existsSync(join(rootDir, ".fusion", "fusion.db"));
}

export class LinkedWorktreeBootstrapRefusedError extends Error {
  constructor(cwd: string, parentRoot: string) {
    super(
      `Refusing to bootstrap a Fusion project at ${cwd}: this is a linked worktree of ${parentRoot}, which already has a Fusion project at ${parentRoot}/.fusion. Run from the parent, or set FUSION_ALLOW_NESTED_PROJECT=1 to override.`,
    );
    this.name = "LinkedWorktreeBootstrapRefusedError";
  }
}

export function assertProjectRootDir(rootDir: string, caller: string): void {
  if (FUSION_DIR_SUFFIX.test(rootDir)) {
    throw new Error(
      `[fusion] ${caller} expected a project root, got a .fusion directory: ${rootDir}\n` +
      "Pass the project root instead; this store appends `.fusion` internally.",
    );
  }
}

export function assertNotLinkedWorktreeOfExistingProject(rootDir: string, _caller: string): void {
  const resolvedRootDir = resolve(rootDir);
  if (hasFusionProjectSignal(resolvedRootDir)) {
    return;
  }
  if (
    process.env.VITEST === "true"
    && process.env.FUSION_TEST_LINKED_WORKTREE_GUARD !== "1"
  ) {
    return;
  }
  if (process.env.FUSION_ALLOW_NESTED_PROJECT === "1") {
    return;
  }

  const gitCommonDir = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: resolvedRootDir,
    encoding: "utf8",
  });
  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: resolvedRootDir,
    encoding: "utf8",
  });

  if (gitCommonDir.status !== 0 || gitDir.status !== 0) {
    return;
  }

  const resolvedCommonDir = resolve(resolvedRootDir, gitCommonDir.stdout.trim());
  const resolvedGitDir = resolve(resolvedRootDir, gitDir.stdout.trim());
  if (resolvedCommonDir === resolvedGitDir) {
    return;
  }

  const parentRoot = resolvedCommonDir.endsWith(`${join("", ".git")}`)
    ? dirname(resolvedCommonDir)
    : resolvedCommonDir;

  if (!hasFusionProjectSignal(parentRoot)) {
    return;
  }

  throw new LinkedWorktreeBootstrapRefusedError(resolvedRootDir, parentRoot);
}
