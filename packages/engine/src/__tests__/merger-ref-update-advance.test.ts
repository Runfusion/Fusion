import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { advanceIntegrationBranchRef } from "../merger-ref-update-advance.js";

// Signal-safe sweep for fusion-test-ref-advance-* tmp dirs. Vitest's forks pool
// SIGTERMs a fork when a test times out, which skips `finally { rmSync(...) }`
// and leaks dirs that scripts/check-test-isolation.mjs then fails merge
// verification on.
const TMP_DIR_RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const TMP_DIR_CLEANUP_HOOK_KEY = Symbol.for(
  "fusion.engine.merger-ref-update-advance-test.tmp-cleanup-hooks-installed",
);
const trackedTmpDirs = new Set<string>();

function removeTmpDirSync(dir: string): void {
  try {
    rmSync(dir, TMP_DIR_RM_OPTIONS);
  } catch {
    // best-effort fallback during teardown
  } finally {
    trackedTmpDirs.delete(dir);
  }
}

function cleanupTmpDirsSync(): void {
  for (const dir of Array.from(trackedTmpDirs)) removeTmpDirSync(dir);
}

const processWithCleanupFlag = process as typeof process & {
  [TMP_DIR_CLEANUP_HOOK_KEY]?: boolean;
};
if (!processWithCleanupFlag[TMP_DIR_CLEANUP_HOOK_KEY]) {
  process.once("beforeExit", cleanupTmpDirsSync);
  process.once("exit", cleanupTmpDirsSync);
  processWithCleanupFlag[TMP_DIR_CLEANUP_HOOK_KEY] = true;
}

afterAll(() => {
  cleanupTmpDirsSync();
});

function git(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
}

function setupRepo(defaultBranch: "main" | "master" = "main") {
  const dir = mkdtempSync(join(tmpdir(), "fusion-test-ref-advance-"));
  trackedTmpDirs.add(dir);
  git(dir, `git init -b ${defaultBranch}`);
  git(dir, "git config user.name tester");
  git(dir, "git config user.email tester@example.com");
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  git(dir, "git add tracked.txt");
  git(dir, "git commit -m init");
  return dir;
}

describe("advanceIntegrationBranchRef", () => {
  it.each(["main", "master"] as const)("advances %s via update-ref happy path", async (integrationBranch) => {
    const dir = setupRepo(integrationBranch);
    const events: Array<{ type: string; target?: string; metadata?: Record<string, unknown> }> = [];
    try {
      const expectedCurrentSha = git(dir, `git rev-parse refs/heads/${integrationBranch}`);
      git(dir, "git checkout -b feat");
      writeFileSync(join(dir, "feature.txt"), "feature\n");
      git(dir, "git add feature.txt");
      git(dir, "git commit -m feat");
      const newSha = git(dir, "git rev-parse HEAD");

      const result = await advanceIntegrationBranchRef({
        rootDir: dir,
        projectRootDir: dir,
        integrationBranch,
        newSha,
        expectedCurrentSha,
        taskId: "FN-5350",
        audit: {
          git: async (event: any) => events.push(event),
        } as any,
      });

      expect(result).toEqual({ advanced: true, previousSha: expectedCurrentSha, newSha });
      expect(git(dir, `git rev-parse refs/heads/${integrationBranch}`)).toBe(newSha);
      expect(events[0]?.type).toBe("merge:integration-ref-advance");
      expect(events[0]?.metadata?.advanceMode).toBe("update-ref");
      expect(events[0]?.metadata?.succeeded).toBe(true);
      expect(events[0]?.metadata?.refName).toBe(`refs/heads/${integrationBranch}`);
      expect(events[0]?.target).toBe(integrationBranch);
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("returns concurrent-advance when observed tip differs from expected", async () => {
    const dir = setupRepo("main");
    const events: Array<{ type: string; metadata?: Record<string, unknown> }> = [];
    try {
      const staleExpectedSha = git(dir, "git rev-parse refs/heads/main");
      git(dir, "git checkout -b other");
      writeFileSync(join(dir, "other.txt"), "other\n");
      git(dir, "git add other.txt");
      git(dir, "git commit -m other");
      const observedCurrentSha = git(dir, "git rev-parse HEAD");
      git(dir, `git update-ref refs/heads/main ${observedCurrentSha} ${staleExpectedSha}`);

      git(dir, "git checkout -b feat2");
      writeFileSync(join(dir, "feature2.txt"), "feature2\n");
      git(dir, "git add feature2.txt");
      git(dir, "git commit -m feat2");
      const newSha = git(dir, "git rev-parse HEAD");

      const result = await advanceIntegrationBranchRef({
        rootDir: dir,
        projectRootDir: dir,
        integrationBranch: "main",
        newSha,
        expectedCurrentSha: staleExpectedSha,
        taskId: "FN-5350",
        audit: {
          git: async (event: any) => events.push(event),
        } as any,
      });

      expect(result.advanced).toBe(false);
      if (result.advanced) throw new Error("expected refusal");
      expect(result.reason).toBe("concurrent-advance");
      expect(result.observedCurrentSha).toBe(observedCurrentSha);
      expect(git(dir, "git rev-parse refs/heads/main")).toBe(observedCurrentSha);
      expect(events[0]?.type).toBe("merge:integration-ref-advance");
      expect(events[0]?.metadata?.succeeded).toBe(false);
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("keeps dirty and untracked files untouched while advancing", async () => {
    const dir = setupRepo("main");
    try {
      const expectedCurrentSha = git(dir, "git rev-parse refs/heads/main");
      git(dir, "git checkout -b feat");
      writeFileSync(join(dir, "feature.txt"), "feature\n");
      git(dir, "git add feature.txt");
      git(dir, "git commit -m feat");
      const newSha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      writeFileSync(join(dir, "tracked.txt"), "one\nuser-local-edit\n");
      writeFileSync(join(dir, "untracked.txt"), "untracked\n");
      const trackedBefore = readFileSync(join(dir, "tracked.txt"), "utf-8");
      const untrackedBefore = readFileSync(join(dir, "untracked.txt"), "utf-8");

      const result = await advanceIntegrationBranchRef({
        rootDir: dir,
        projectRootDir: dir,
        integrationBranch: "main",
        newSha,
        expectedCurrentSha,
        taskId: "FN-5350",
        audit: { git: async () => undefined } as any,
      });

      expect(result.advanced).toBe(true);
      expect(readFileSync(join(dir, "tracked.txt"), "utf-8")).toBe(trackedBefore);
      expect(readFileSync(join(dir, "untracked.txt"), "utf-8")).toBe(untrackedBefore);
      expect(existsSync(join(dir, "untracked.txt"))).toBe(true);
      const status = git(dir, "git status --porcelain");
      expect(status).toContain("tracked.txt");
      expect(status).toContain("untracked.txt");
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("refuses non-fast-forward advance even when expectedCurrentSha matches (sibling-commit orphan guard)", async () => {
    const dir = setupRepo("main");
    const events: Array<{ type: string; metadata?: Record<string, unknown> }> = [];
    try {
      const baseSha = git(dir, "git rev-parse refs/heads/main");

      // First sibling — legitimate prior merger output that advanced main.
      git(dir, "git checkout -b sibling-a");
      writeFileSync(join(dir, "a.txt"), "a\n");
      git(dir, "git add a.txt");
      git(dir, "git commit -m a");
      const siblingASha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");
      git(dir, `git update-ref refs/heads/main ${siblingASha} ${baseSha}`);

      // Second sibling — built off the stale base (the bug shape). Both
      // shas have the same parent, so siblingA is NOT an ancestor of
      // siblingB. CAS alone would happily move main from siblingA to
      // siblingB and orphan siblingA.
      git(dir, `git checkout ${baseSha}`);
      git(dir, "git checkout -b sibling-b");
      writeFileSync(join(dir, "b.txt"), "b\n");
      git(dir, "git add b.txt");
      git(dir, "git commit -m b");
      const siblingBSha = git(dir, "git rev-parse HEAD");

      const result = await advanceIntegrationBranchRef({
        rootDir: dir,
        projectRootDir: dir,
        integrationBranch: "main",
        newSha: siblingBSha,
        expectedCurrentSha: siblingASha,
        taskId: "FN-5419",
        audit: {
          git: async (event: any) => events.push(event),
        } as any,
      });

      expect(result.advanced).toBe(false);
      if (result.advanced) throw new Error("expected refusal");
      expect(result.reason).toBe("non-fast-forward-advance");
      // Ref must NOT have moved — siblingA is still reachable from main.
      expect(git(dir, "git rev-parse refs/heads/main")).toBe(siblingASha);
      expect(events[0]?.type).toBe("merge:integration-ref-advance");
      expect(events[0]?.metadata?.succeeded).toBe(false);
      expect(String(events[0]?.metadata?.error ?? "")).toContain(
        "non-fast-forward-advance",
      );
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("allows multi-commit fast-forward advance", async () => {
    const dir = setupRepo("main");
    try {
      const baseSha = git(dir, "git rev-parse refs/heads/main");
      git(dir, "git checkout -b feat");
      writeFileSync(join(dir, "f1.txt"), "f1\n");
      git(dir, "git add f1.txt");
      git(dir, "git commit -m f1");
      writeFileSync(join(dir, "f2.txt"), "f2\n");
      git(dir, "git add f2.txt");
      git(dir, "git commit -m f2");
      const newSha = git(dir, "git rev-parse HEAD");

      const result = await advanceIntegrationBranchRef({
        rootDir: dir,
        projectRootDir: dir,
        integrationBranch: "main",
        newSha,
        expectedCurrentSha: baseSha,
        taskId: "FN-5419",
        audit: { git: async () => undefined } as any,
      });

      expect(result.advanced).toBe(true);
      expect(git(dir, "git rev-parse refs/heads/main")).toBe(newSha);
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("throws on missing precondition shas", async () => {
    const dir = setupRepo("main");
    try {
      await expect(advanceIntegrationBranchRef({
        rootDir: dir,
        projectRootDir: dir,
        integrationBranch: "main",
        newSha: "",
        expectedCurrentSha: "abc",
        taskId: "FN-5350",
        audit: { git: async () => undefined } as any,
      })).rejects.toThrow("newSha");

      await expect(advanceIntegrationBranchRef({
        rootDir: dir,
        projectRootDir: dir,
        integrationBranch: "main",
        newSha: "abc",
        expectedCurrentSha: "",
        taskId: "FN-5350",
        audit: { git: async () => undefined } as any,
      })).rejects.toThrow("expectedCurrentSha");
    } finally {
      removeTmpDirSync(dir);
    }
  });
});
