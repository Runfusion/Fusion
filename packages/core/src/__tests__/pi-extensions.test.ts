import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { getProjectRootFromWorktree, resolvePiExtensionProjectRoot } from "../pi-extensions.js";

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("getProjectRootFromWorktree", () => {
  it("detects POSIX worktree paths", () => {
    expect(getProjectRootFromWorktree("/repo/.worktrees/fn-001")).toBe("/repo");
    expect(getProjectRootFromWorktree("/repo/.worktrees/fn-001/src/file.ts")).toBe("/repo");
    expect(getProjectRootFromWorktree("/repo/.fusion/worktrees/fn-001")).toBe("/repo");
    expect(getProjectRootFromWorktree("/repo/.fusion/worktrees/fn-001/src/file.ts")).toBe("/repo");
  });

  it("detects Windows worktree paths", () => {
    expect(getProjectRootFromWorktree("C:\\repo\\.worktrees\\fn-001")).toBe("C:\\repo");
    expect(getProjectRootFromWorktree("C:\\repo\\.worktrees\\fn-001\\src\\file.ts")).toBe("C:\\repo");
    expect(getProjectRootFromWorktree("C:\\repo\\.fusion\\worktrees\\fn-001")).toBe("C:\\repo");
    expect(getProjectRootFromWorktree("C:\\repo\\.fusion\\worktrees\\fn-001\\src\\file.ts")).toBe("C:\\repo");
  });

  it("supports configured candidate worktrees dir paths", () => {
    expect(
      getProjectRootFromWorktree("/tmp/.fn-worktrees/repo/fn-001/src", {
        worktreesDirCandidates: ["/tmp/.fn-worktrees/repo"],
      }),
    ).toBe("/tmp/.fn-worktrees");

    expect(
      getProjectRootFromWorktree("/tmp/repo.worktrees/fn-001", {
        worktreesDirCandidates: ["/tmp/repo.worktrees"],
      }),
    ).toBe("/tmp");
  });

  it("returns null without throwing when child_process partial mocks omit spawnSync", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execSync: vi.fn(),
    }));

    try {
      const { getProjectRootFromWorktree: getProjectRootFromWorktreeWithPartialMock } = await import(
        "../pi-extensions.js"
      );
      const unmatchedPath = join(tmpdir(), "fn-6102-not-a-worktree");

      expect(() => getProjectRootFromWorktreeWithPartialMock(unmatchedPath)).not.toThrow();
      expect(getProjectRootFromWorktreeWithPartialMock(unmatchedPath)).toBe(null);
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("detects arbitrary Git linked worktree paths when the parent has Fusion metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "fn-6079-root-"));
    const worktreeRoot = mkdtempSync(join(tmpdir(), "fusion-ai-merge-fn-6079-"));
    try {
      const expectedRoot = realpathSync(root);
      git(root, "init -q -b main");
      git(root, "config user.email test@example.com");
      git(root, "config user.name Test");
      mkdirSync(join(root, ".fusion"), { recursive: true });
      writeFileSync(join(root, "base.txt"), "base\n");
      git(root, "add -A");
      git(root, "commit -q -m base");
      git(root, `worktree add --detach ${JSON.stringify(worktreeRoot)} HEAD`);
      mkdirSync(join(worktreeRoot, "subdir"), { recursive: true });

      expect(getProjectRootFromWorktree(worktreeRoot)).toBe(expectedRoot);
      expect(getProjectRootFromWorktree(join(worktreeRoot, "subdir"))).toBe(expectedRoot);
      expect(resolvePiExtensionProjectRoot(worktreeRoot)).toBe(expectedRoot);
    } finally {
      try {
        git(root, `worktree remove --force ${JSON.stringify(worktreeRoot)}`);
      } catch {
        // best effort cleanup
      }
      rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FNXC:Storage 2026-07-09-00:00: FN-7730 regression — a non-standard-location
  // linked worktree (settings.worktreesDir configured off the default
  // `.worktrees`, e.g. containerized deployments) must resolve to the true
  // project root via git's own on-disk `.git`/`commondir` worktree metadata,
  // WITHOUT depending on the `git` CLI succeeding. Previously the only
  // non-standard-location resolution path was `git rev-parse`, which silently
  // returns null (no thrown error) when the `git` binary is unavailable or
  // fails (e.g. Docker "detected dubious ownership" safe.directory refusal on a
  // bind-mounted repo) — collapsing resolution to a naive `.fusion` upward walk
  // that stops at the worktree's OWN locally-hydrated `.fusion/fusion.db`
  // instead of the real project root.
  it("resolves a non-standard-location linked worktree via .git/commondir metadata even when the git CLI is unavailable", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "fatal: detected dubious ownership" })),
      execSync: vi.fn(),
    }));

    const root = mkdtempSync(join(tmpdir(), "fn-7730-root-"));
    // Deliberately NOT under a `.worktrees`/`.fusion/worktrees` path so the
    // hardcoded regex fast paths in getProjectRootFromWorktree cannot match.
    const worktreeDir = mkdtempSync(join(tmpdir(), "fn-7730-custom-wt-"));
    try {
      const expectedRoot = resolve(root);
      mkdirSync(join(root, ".fusion"), { recursive: true });

      // Fabricate the on-disk linked-worktree metadata git itself would write
      // for `git worktree add <worktreeDir>` — no real git repo/binary needed.
      const worktreeGitDir = join(root, ".git", "worktrees", "custom-wt");
      mkdirSync(worktreeGitDir, { recursive: true });
      writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
      writeFileSync(join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);

      const { getProjectRootFromWorktree: fresh } = await import("../pi-extensions.js");
      expect(fresh(worktreeDir)).toBe(expectedRoot);
      expect(fresh(join(worktreeDir, "subdir", "file.ts"))).toBe(expectedRoot);
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
      rmSync(worktreeDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FNXC:Storage 2026-07-09-00:00: FN-7730 symptom verification — reproduces the
  // exact silent-write-loss shape: a non-standard-location worktree that ALSO
  // already has its own locally-hydrated `.fusion/fusion.db` (created by
  // hydrateWorktreeDb for dependency-closure hydration) must still resolve to
  // the TRUE project root, not the worktree's decoy `.fusion` — even with the
  // git CLI unavailable. Before the fix this returned the worktree itself,
  // silently redirecting every fn_task_update-style write into the throwaway
  // hydration copy.
  it("prefers the true project root over a worktree's own hydrated .fusion when git is unavailable (FN-7730)", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "fatal: detected dubious ownership" })),
      execSync: vi.fn(),
    }));

    const root = mkdtempSync(join(tmpdir(), "fn-7730-root2-"));
    const worktreeDir = mkdtempSync(join(tmpdir(), "fn-7730-custom-wt2-"));
    try {
      const expectedRoot = resolve(root);
      mkdirSync(join(root, ".fusion"), { recursive: true });

      const worktreeGitDir = join(root, ".git", "worktrees", "custom-wt2");
      mkdirSync(worktreeGitDir, { recursive: true });
      writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
      writeFileSync(join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);

      // Simulate hydrateWorktreeDb's ensureWorktreeSchema: the worktree gets its
      // own local `.fusion` directory as a hydration/decoy target.
      mkdirSync(join(worktreeDir, ".fusion"), { recursive: true });

      const { resolvePiExtensionProjectRoot: fresh } = await import("../pi-extensions.js");
      expect(fresh(worktreeDir)).toBe(expectedRoot);
      expect(fresh(worktreeDir)).not.toBe(resolve(worktreeDir));
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
      rmSync(worktreeDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("@fusion/core export surface", () => {
  it("re-exports getProjectRootFromWorktree as a callable function", async () => {
    const core = await import("../index.js");
    expect(typeof core.getProjectRootFromWorktree).toBe("function");
  });
});

describe("resolvePiExtensionProjectRoot", () => {
  it("prefers parent repo root for worktree paths when parent .fusion exists", () => {
    const root = mkdtempSync(join(tmpdir(), "fn-4904-root-"));
    try {
      mkdirSync(join(root, ".fusion"), { recursive: true });
      mkdirSync(join(root, ".worktrees", "feature", ".fusion"), { recursive: true });
      mkdirSync(join(root, ".fusion", "worktrees", "feature", ".fusion"), { recursive: true });
      const legacyCwd = join(root, ".worktrees", "feature", "sub");
      const fusionCwd = join(root, ".fusion", "worktrees", "feature", "sub");
      mkdirSync(legacyCwd, { recursive: true });
      mkdirSync(fusionCwd, { recursive: true });

      expect(resolvePiExtensionProjectRoot(legacyCwd)).toBe(root);
      expect(resolvePiExtensionProjectRoot(fusionCwd)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to legacy walk when parent repo root does not have .fusion", () => {
    const root = mkdtempSync(join(tmpdir(), "fn-4904-root-"));
    try {
      const worktreeRoot = join(root, ".worktrees", "feature");
      mkdirSync(join(worktreeRoot, ".fusion"), { recursive: true });
      const cwd = join(worktreeRoot, "sub");
      mkdirSync(cwd, { recursive: true });

      expect(resolvePiExtensionProjectRoot(cwd)).toBe(worktreeRoot);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves non-worktree behavior", () => {
    const root = mkdtempSync(join(tmpdir(), "fn-4904-root-"));
    try {
      mkdirSync(join(root, ".fusion"), { recursive: true });
      const cwd = join(root, "sub", "dir");
      mkdirSync(cwd, { recursive: true });

      expect(resolvePiExtensionProjectRoot(cwd)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
