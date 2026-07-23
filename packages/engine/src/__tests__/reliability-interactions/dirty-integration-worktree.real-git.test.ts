import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git, hasGit } from "./_helpers.js";
import { advanceIntegrationBranchRef, __test__ } from "../../merge/merger-ref-update-advance.js";

// Vitest's forks pool SIGTERMs a fork when a test times out, which skips any
// in-test `finally { rmSync(...) }` and leaves `fusion-test-ref-*-project-*`
// dirs behind. scripts/check-test-isolation.mjs then fails deterministic merge
// verification with these as leaks. Track every minted dir and sweep them in
// signal/exit handlers as a backstop.
const TMP_DIR_RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const TMP_DIR_CLEANUP_HOOK_KEY = Symbol.for(
  "fusion.engine.dirty-integration-worktree-test.tmp-cleanup-hooks-installed",
);
const trackedTmpDirs = new Set<string>();

function mintTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trackedTmpDirs.add(dir);
  return dir;
}

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

describe.skipIf(!hasGit)("reliability interaction: dirty integration worktree with ref-only advance", () => {
  it.each(["main", "master"] as const)("advances %s without touching dirty/untracked files", async (integrationBranch) => {
    const projectRootDir = mintTmpDir("fusion-test-ref-project-");
    const rootDir = join(projectRootDir, "task-wt");
    const events: any[] = [];
    const runGitSpy = vi.spyOn(__test__, "runGit");
    try {
      git(projectRootDir, `git init -b ${integrationBranch}`);
      git(projectRootDir, "git config user.name tester");
      git(projectRootDir, "git config user.email tester@example.com");
      writeFileSync(join(projectRootDir, "tracked.ts"), "export const a = 1;\n");
      git(projectRootDir, "git add tracked.ts");
      git(projectRootDir, "git commit -m init");

      const expectedCurrentSha = git(projectRootDir, `git rev-parse refs/heads/${integrationBranch}`);
      git(projectRootDir, "git checkout -b feature");
      writeFileSync(join(projectRootDir, "feature.ts"), "export const feature = true;\n");
      git(projectRootDir, "git add feature.ts");
      git(projectRootDir, "git commit -m feature");
      const newSha = git(projectRootDir, "git rev-parse HEAD");
      git(projectRootDir, `git checkout ${integrationBranch}`);
      git(projectRootDir, `git branch task-wt feature`);
      git(projectRootDir, `git worktree add ${JSON.stringify(rootDir)} task-wt`);

      writeFileSync(join(projectRootDir, "tracked.ts"), "export const a = 1;\nuser-local-edit\n");
      writeFileSync(join(projectRootDir, "new-untracked.txt"), "untracked\n");
      const trackedBefore = readFileSync(join(projectRootDir, "tracked.ts"), "utf-8");
      const untrackedBefore = readFileSync(join(projectRootDir, "new-untracked.txt"), "utf-8");

      const result = await advanceIntegrationBranchRef({
        rootDir,
        projectRootDir,
        integrationBranch,
        newSha,
        expectedCurrentSha,
        taskId: "FN-5350",
        audit: { git: async (event: any) => events.push(event) } as any,
      });

      expect(result).toEqual({ advanced: true, previousSha: expectedCurrentSha, newSha });
      expect(git(projectRootDir, `git rev-parse refs/heads/${integrationBranch}`)).toBe(newSha);
      expect(readFileSync(join(projectRootDir, "tracked.ts"), "utf-8")).toBe(trackedBefore);
      expect(readFileSync(join(projectRootDir, "new-untracked.txt"), "utf-8")).toBe(untrackedBefore);
      expect(existsSync(join(projectRootDir, "new-untracked.txt"))).toBe(true);
      expect(git(projectRootDir, "git status --porcelain")).toContain("new-untracked.txt");

      const updateRefCalls = runGitSpy.mock.calls.filter(([args]) => Array.isArray(args) && args[0] === "update-ref");
      expect(updateRefCalls).toHaveLength(1);
      expect(updateRefCalls[0]?.[1]).toBe(rootDir);
      expect(runGitSpy.mock.calls.some(([args, cwd]) => {
        if (cwd !== projectRootDir || !Array.isArray(args)) return false;
        return ["checkout", "merge", "rebase", "update-ref"].includes(args[0] ?? "");
      })).toBe(false);

      const advanceEvent = events.find((event) => event.type === "merge:integration-ref-advance");
      expect(advanceEvent?.metadata?.advanceMode).toBe("update-ref");
      expect(advanceEvent?.metadata?.succeeded).toBe(true);
      expect(advanceEvent?.target).toBe(integrationBranch);
      if (integrationBranch === "master") {
        expect(JSON.stringify(advanceEvent)).not.toContain('"main"');
      }
    } finally {
      runGitSpy.mockRestore();
      removeTmpDirSync(projectRootDir);
    }
  });

  it("returns concurrent-advance and preserves concurrent ref", async () => {
    const projectRootDir = mintTmpDir("fusion-test-ref-concurrent-project-");
    const rootDir = join(projectRootDir, "task-wt");
    const events: any[] = [];
    try {
      git(projectRootDir, "git init -b main");
      git(projectRootDir, "git config user.name tester");
      git(projectRootDir, "git config user.email tester@example.com");
      writeFileSync(join(projectRootDir, "tracked.ts"), "export const a = 1;\n");
      git(projectRootDir, "git add tracked.ts");
      git(projectRootDir, "git commit -m init");

      const expectedCurrentSha = git(projectRootDir, "git rev-parse refs/heads/main");
      git(projectRootDir, "git checkout -b concurrent");
      writeFileSync(join(projectRootDir, "concurrent.ts"), "export const concurrent = 1;\n");
      git(projectRootDir, "git add concurrent.ts");
      git(projectRootDir, "git commit -m concurrent");
      const observedCurrentSha = git(projectRootDir, "git rev-parse HEAD");
      git(projectRootDir, `git update-ref refs/heads/main ${observedCurrentSha} ${expectedCurrentSha}`);

      git(projectRootDir, "git checkout -b feature");
      writeFileSync(join(projectRootDir, "feature.ts"), "export const feature = true;\n");
      git(projectRootDir, "git add feature.ts");
      git(projectRootDir, "git commit -m feature");
      const newSha = git(projectRootDir, "git rev-parse HEAD");
      git(projectRootDir, "git checkout main");
      git(projectRootDir, "git branch task-wt feature");
      git(projectRootDir, `git worktree add ${JSON.stringify(rootDir)} task-wt`);

      const result = await advanceIntegrationBranchRef({
        rootDir,
        projectRootDir,
        integrationBranch: "main",
        newSha,
        expectedCurrentSha,
        taskId: "FN-5350",
        audit: { git: async (event: any) => events.push(event) } as any,
      });

      expect(result.advanced).toBe(false);
      if (result.advanced) throw new Error("expected refusal");
      expect(result.reason).toBe("concurrent-advance");
      expect(git(projectRootDir, "git rev-parse refs/heads/main")).toBe(observedCurrentSha);
      const failureEvent = events.find((event) => event.type === "merge:integration-ref-advance");
      expect(failureEvent?.metadata?.succeeded).toBe(false);
      expect(String(failureEvent?.metadata?.error ?? "")).toContain("concurrent-advance");
    } finally {
      removeTmpDirSync(projectRootDir);
    }
  });
});
