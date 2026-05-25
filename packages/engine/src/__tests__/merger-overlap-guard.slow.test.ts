// Real-git wallclock under parallel CI load; do not lower per-test timeouts
// without re-measuring under pnpm test:full. (FN-4839)
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../pi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pi.js")>();
  return {
    ...actual,
    describeModel: vi.fn(() => "mock-provider/mock-model"),
    promptWithFallback: vi.fn(async (session, prompt, options) => {
      if (options === undefined) {
        await session.prompt(prompt);
      } else {
        await session.prompt(prompt, options);
      }
    }),
  };
});

vi.mock("../agent-session-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-session-helpers.js")>();
  return {
    ...actual,
    createResolvedAgentSession: vi.fn(async () => ({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("Agent failed")),
        dispose: vi.fn(),
      },
      runtimeId: "mock-runtime",
      wasConfigured: false,
    })),
  };
});

vi.mock("../merger-squash-audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merger-squash-audit.js")>();
  return {
    ...actual,
    auditSquashMerge: vi.fn(async () => ({
      squashSha: "mergedcommit123",
      parentSha: "parent123",
      squashSubject: "feat: squash merge",
      lookback: 30,
      branchSubjects: [],
      recentMainSubjects: [],
      duplicateSubjects: [],
      touchedFiles: [],
      touchedFileOverlaps: [],
      findings: [],
      issueCount: 0,
      clean: true,
    })),
  };
});

import type { Task, TaskStore } from "@fusion/core";
import { DEFAULT_SETTINGS } from "@fusion/core";
import { aiMergeTask } from "../merger.js";
import {
  detectMergeOverlap,
  getBranchTouchedFiles,
  getRecentMainTouchedFiles,
  restoreBranchWinsFiles,
} from "../merger-overlap-guard.js";

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, stdio: "pipe" }).toString().trim();
}

function initRepo(dir: string): string {
  git(dir, "git init -b main");
  git(dir, 'git config user.email "test@example.com"');
  git(dir, 'git config user.name "Test"');
  git(dir, 'git config commit.gpgsign false');
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, "git add README.md");
  git(dir, 'git commit -m "chore: initial commit"');
  return git(dir, "git rev-parse HEAD");
}

/**
 * Reset a shared test repo to its initial-commit state between tests. Lets
 * tests in this file reuse one `git init` instead of paying ~5 git
 * invocations per test in beforeEach. Safe because the file runs in the
 * single-threaded `engine-slow` vitest project.
 */
function resetRepoToInitial(dir: string, initialSha: string): void {
  // Bring HEAD back to main and to the initial commit.
  git(dir, "git checkout -f main");
  git(dir, `git reset --hard ${initialSha}`);
  // Drop any feature branches left behind by earlier tests.
  const branchListing = git(dir, "git for-each-ref --format='%(refname:short)' refs/heads/");
  for (const ref of branchListing.split("\n").map((entry) => entry.replace(/^'|'$/g, "").trim()).filter(Boolean)) {
    if (ref === "main") continue;
    git(dir, `git branch -D ${ref}`);
  }
  // Remove any leftover working-tree files (untracked or ignored).
  git(dir, "git clean -fdx");
}

function commitFile(dir: string, file: string, content: string, message: string): string {
  writeFileSync(join(dir, file), content);
  git(dir, `git add ${file}`);
  git(dir, `git commit -m "${message}"`);
  return git(dir, "git rev-parse HEAD");
}

function createBranchFromMain(dir: string, branch: string): void {
  git(dir, `git checkout -b ${branch} main`);
}

function makeStore(dir: string, taskId: string, settingsOverrides: Record<string, unknown> = {}): TaskStore {
  const task: Task = {
    id: taskId,
    title: "Overlap guard task",
    description: "Test overlap-aware merge fallback",
    column: "in-review",
    baseBranch: "main",
    branch: taskId,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return {
    getTask: vi.fn().mockResolvedValue(task),
    listTasks: vi.fn().mockResolvedValue([task]),
    updateTask: vi.fn().mockResolvedValue(task),
    moveTask: vi.fn().mockResolvedValue(task),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      commitAuthorEnabled: false,
      mergeConflictStrategy: "smart-prefer-main",
      ...settingsOverrides,
    }),
    getActiveMergingTask: vi.fn().mockReturnValue(null),
    emit: vi.fn(),
    on: vi.fn(),
    clearStaleExecutionStartBranchReferences: vi.fn().mockReturnValue([]),
    getVerificationCacheHit: vi.fn().mockReturnValue(null),
    recordVerificationCachePass: vi.fn(),
  } as unknown as TaskStore;
}

function commitSeries(dir: string, prefix: string, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    commitFile(
      dir,
      `${prefix}-${index}.txt`,
      `${prefix} ${index}\n`,
      `chore: ${prefix} ${index}`,
    );
  }
}

async function runOverlapMerge(dir: string, taskId: string, settingsOverrides: Record<string, unknown> = {}) {
  const store = makeStore(dir, taskId, settingsOverrides);
  const result = await aiMergeTask(store, dir, taskId);
  return { store, result };
}

function testTempParent(): string {
  return process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir();
}

function assertIsolatedWorkspace(dir: string): void {
  const repoRoot = process.env.FUSION_TEST_REAL_ROOT;
  if (!repoRoot) return;
  expect(resolve(dir).startsWith(resolve(repoRoot))).toBe(false);
}

const createdDirs = new Set<string>();

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cleanupTempDir(dir?: string): void {
  if (!dir) return;
  createdDirs.delete(dir);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      if (!existsSync(dir)) return;
      rmSync(dir, { recursive: true, force: true });
      if (!existsSync(dir)) return;
    } catch (error) {
      if (attempt === 5) {
        throw error;
      }
    }

    sleepSync(attempt * 25);
  }

  if (existsSync(dir)) {
    throw new Error(`failed to clean temp dir: ${dir}`);
  }
}

// Shared test repo across both describes. Each test resets HEAD to the
// initial commit and clears all non-main branches in beforeEach (see
// resetRepoToInitial). Saves the ~5 git invocations per test that the
// previous per-test mkdtemp + init pattern paid; brings this file from
// ~17s to ~5s.
let sharedDir: string;
let initialSha: string;

beforeAll(() => {
  sharedDir = mkdtempSync(join(testTempParent(), "fusion-test-overlap-shared-"));
  createdDirs.add(sharedDir);
  assertIsolatedWorkspace(sharedDir);
  initialSha = initRepo(sharedDir);
});

afterAll(() => {
  for (const dir of Array.from(createdDirs)) {
    cleanupTempDir(dir);
  }
});

describe("merger overlap guard", () => {
  let dir: string;

  beforeEach(() => {
    dir = sharedDir;
    resetRepoToInitial(dir, initialSha);
  });

  it("detects overlap when branch and recent main commits touch the same file", async () => {
    commitFile(dir, "shared.ts", "export const shared = 1;\n", "feat: add shared file");
    commitFile(dir, "main-only.ts", "export const mainOnly = true;\n", "feat: add main file");

    createBranchFromMain(dir, "feature/overlap");
    commitFile(dir, "shared.ts", "export const shared = 2;\n", "feat: harden shared file");

    const overlap = await detectMergeOverlap({
      rootDir: dir,
      branch: "feature/overlap",
      baseRef: "main",
      mergeTargetBranch: "main",
      lookback: 30,
    });

    expect(overlap.overlappingFiles).toEqual(["shared.ts"]);
    expect(overlap.recentMainCommitsByFile.get("shared.ts")).toHaveLength(1);
  });

  it("returns no overlap when branch files are absent from recent main commits", async () => {
    commitFile(dir, "main-only.ts", "export const mainOnly = true;\n", "feat: add main file");

    createBranchFromMain(dir, "feature/no-overlap");
    commitFile(dir, "branch-only.ts", "export const branchOnly = true;\n", "feat: add branch file");

    const overlap = await detectMergeOverlap({
      rootDir: dir,
      branch: "feature/no-overlap",
      baseRef: "main",
      mergeTargetBranch: "main",
      lookback: 30,
    });

    expect(overlap.overlappingFiles).toEqual([]);
    expect(overlap.recentMainCommitsByFile.size).toBe(0);
  });

  it("ignores commits outside the lookback window", async () => {
    commitFile(dir, "shared.ts", "export const shared = 1;\n", "feat: add shared file");
    commitFile(dir, "a.ts", "export const a = 1;\n", "feat: add a");
    commitFile(dir, "b.ts", "export const b = 1;\n", "feat: add b");

    createBranchFromMain(dir, "feature/lookback");
    commitFile(dir, "shared.ts", "export const shared = 2;\n", "feat: update shared file");

    const recentMain = await getRecentMainTouchedFiles({
      rootDir: dir,
      mergeTargetBranch: "main",
      lookback: 2,
    });
    expect(recentMain.has("shared.ts")).toBe(false);

    const overlap = await detectMergeOverlap({
      rootDir: dir,
      branch: "feature/lookback",
      baseRef: "main",
      mergeTargetBranch: "main",
      lookback: 2,
    });

    expect(overlap.overlappingFiles).toEqual([]);
  });

  it("uses the provided base ref when collecting branch touched files", async () => {
    commitFile(dir, "base.ts", "export const base = 1;\n", "feat: add base file");
    createBranchFromMain(dir, "feature/base-ref");
    commitFile(dir, "feature.ts", "export const feature = 1;\n", "feat: add feature file");

    const files = await getBranchTouchedFiles({
      rootDir: dir,
      branch: "feature/base-ref",
      baseRef: "main",
    });

    expect(files).toEqual(["feature.ts"]);
  });

  it("restores the branch version for overlapping files after a -X ours squash", async () => {
    commitFile(dir, "store.ts", "export const mode = 'base';\n", "feat: add store");
    createBranchFromMain(dir, "feature/mixed");
    commitFile(dir, "store.ts", "export const mode = 'branch hardening';\n", "feat: harden store");

    git(dir, "git checkout main");
    commitFile(dir, "store.ts", "export const mode = 'main fallback';\n", "feat: main store update");

    git(dir, "git merge -X ours --squash feature/mixed");
    expect(git(dir, "git show :store.ts")).toContain("main fallback");

    await restoreBranchWinsFiles({
      rootDir: dir,
      branch: "feature/mixed",
      files: ["store.ts"],
    });

    expect(git(dir, "git show :store.ts")).toContain("branch hardening");
  });

  it("preserves legacy main-wins behavior when no overlapping files are restored", async () => {
    commitFile(dir, "store.ts", "export const mode = 'base';\n", "feat: add store");
    createBranchFromMain(dir, "feature/no-restore");
    commitFile(dir, "store.ts", "export const mode = 'branch hardening';\n", "feat: harden store");

    git(dir, "git checkout main");
    commitFile(dir, "store.ts", "export const mode = 'main fallback';\n", "feat: main store update");

    git(dir, "git merge -X ours --squash feature/no-restore");

    expect(git(dir, "git show :store.ts")).toContain("main fallback");
  });

  it("replays the FN-3936 shape so branch hardening survives under overlap protection", async () => {
    commitFile(dir, "store.ts", "export function normalize(value) {\n  return value?.trim() ?? \"\";\n}\n", "feat: add store normalizer");
    createBranchFromMain(dir, "feature/fn-3936");
    commitFile(dir, "store.ts", "export function normalize(value) {\n  const trimmed = value?.trim() ?? \"\";\n  return trimmed.slice(0, 128);\n}\n", "feat: harden normalizer");

    git(dir, "git checkout main");
    commitFile(dir, "store.ts", "export function normalize(value) {\n  const trimmed = value?.trim() ?? \"\";\n  return trimmed.toLowerCase();\n}\n", "feat: main follow-up normalizer");

    git(dir, "git merge -X ours --squash feature/fn-3936");
    expect(git(dir, "git show :store.ts")).toContain("toLowerCase");

    await restoreBranchWinsFiles({
      rootDir: dir,
      branch: "feature/fn-3936",
      files: ["store.ts"],
    });

    const stagedStore = git(dir, "git show :store.ts");
    expect(stagedStore).toContain("slice(0, 128)");
    expect(stagedStore).not.toContain("toLowerCase");
  });
});

describe("aiMergeTask overlap-aware fallback integration", () => {
  let dir: string;

  beforeEach(() => {
    dir = sharedDir;
    resetRepoToInitial(dir, initialSha);
  });

  it("defaults to restoring the branch version for overlapping files under smart-prefer-main", async () => {
    commitFile(dir, "store.ts", "export const mode = 'base';\n", "feat: add store");
    createBranchFromMain(dir, "FN-050");
    commitFile(dir, "store.ts", "export const mode = 'branch hardening';\n", "feat: branch hardening");

    git(dir, "git checkout main");
    commitFile(dir, "store.ts", "export const mode = 'main fallback';\n", "feat: main follow-up");

    const { result } = await runOverlapMerge(dir, "FN-050");

    expect(result.merged).toBe(true);
    expect(result.resolutionStrategy).toBe("ours");
    expect(result.resolutionMethod).toBe("mixed");
    expect(git(dir, "git show HEAD:store.ts")).toContain("branch hardening");
    expect(git(dir, "git show HEAD:store.ts")).not.toContain("main fallback");
  }, 60_000);

  it("keeps legacy main-wins behavior when the conflicting main edit is outside the overlap lookback window", async () => {
    commitFile(dir, "store.ts", "export const mode = 'base';\n", "feat: add store");
    createBranchFromMain(dir, "FN-051");
    commitFile(dir, "store.ts", "export const mode = 'branch hardening';\n", "feat: branch hardening");

    git(dir, "git checkout main");
    commitFile(dir, "store.ts", "export const mode = 'main fallback';\n", "feat: main follow-up");
    // 40 filler commits pushes the conflicting main edit well beyond the
    // default 30-commit lookback window, avoiding a tight boundary condition
    // that caused intermittent failures when initRepo/setup commits shifted
    // the effective position of the "main follow-up" commit.
    commitSeries(dir, "filler", 40);

    const { result } = await runOverlapMerge(dir, "FN-051");

    expect(result.merged).toBe(true);
    expect(result.resolutionStrategy).toBe("ours");
    expect(result.resolutionMethod).toBe("ours");
    expect(git(dir, "git show HEAD:store.ts")).toContain("main fallback");
    expect(git(dir, "git show HEAD:store.ts")).not.toContain("branch hardening");
  }, 60_000);

  it("warn-only logs overlap but preserves main-wins behavior", async () => {
    commitFile(dir, "store.ts", "export const mode = 'base';\n", "feat: add store");
    createBranchFromMain(dir, "FN-052");
    commitFile(dir, "store.ts", "export const mode = 'branch hardening';\n", "feat: branch hardening");

    git(dir, "git checkout main");
    commitFile(dir, "store.ts", "export const mode = 'main fallback';\n", "feat: main follow-up");

    const { store, result } = await runOverlapMerge(dir, "FN-052", {
      mergeStrategyOverlapBehavior: "warn-only",
    });

    expect(result.merged).toBe(true);
    expect(result.resolutionMethod).toBe("ours");
    expect(git(dir, "git show HEAD:store.ts")).toContain("main fallback");
    expect(git(dir, "git show HEAD:store.ts")).not.toContain("branch hardening");
    expect(
      vi.mocked(store.appendAgentLog).mock.calls.some(([, message]) => String(message).includes("Overlap guard detected 1 recent-main overlap file(s)")),
    ).toBe(true);
  }, 60_000);

  it("ignore preserves legacy behavior without overlap logging", async () => {
    commitFile(dir, "store.ts", "export const mode = 'base';\n", "feat: add store");
    createBranchFromMain(dir, "FN-053");
    commitFile(dir, "store.ts", "export const mode = 'branch hardening';\n", "feat: branch hardening");

    git(dir, "git checkout main");
    commitFile(dir, "store.ts", "export const mode = 'main fallback';\n", "feat: main follow-up");

    const { store, result } = await runOverlapMerge(dir, "FN-053", {
      mergeStrategyOverlapBehavior: "ignore",
    });

    expect(result.merged).toBe(true);
    expect(result.resolutionMethod).toBe("ours");
    expect(git(dir, "git show HEAD:store.ts")).toContain("main fallback");
    expect(git(dir, "git show HEAD:store.ts")).not.toContain("branch hardening");
    expect(
      vi.mocked(store.appendAgentLog).mock.calls.some(([, message]) => String(message).includes("Overlap guard detected")),
    ).toBe(false);
  }, 60_000);

  it(
    "replays FN-3936 through the merger so branch hardening survives the final squash commit",
    async () => {
      commitFile(dir, "store.ts", "export function normalize(value) {\n  return value?.trim() ?? \"\";\n}\n", "feat: add store normalizer");
      createBranchFromMain(dir, "FN-054");
      commitFile(dir, "store.ts", "export function normalize(value) {\n  const trimmed = value?.trim() ?? \"\";\n  return trimmed.slice(0, 128);\n}\n", "feat: harden normalizer");

      git(dir, "git checkout main");
      commitFile(dir, "store.ts", "export function normalize(value) {\n  const trimmed = value?.trim() ?? \"\";\n  return trimmed.toLowerCase();\n}\n", "feat: main follow-up normalizer");

      const { result } = await runOverlapMerge(dir, "FN-054");
      const mergedStore = git(dir, "git show HEAD:store.ts");

      expect(result.merged).toBe(true);
      expect(result.resolutionMethod).toBe("mixed");
      expect(mergedStore).toContain("slice(0, 128)");
      expect(mergedStore).not.toContain("toLowerCase");
    },
    // FN-4807: this real-git replay can stretch under workspace contention
    // (merge retries + agent-session fallback), so keep a bounded explicit timeout.
    90_000,
  );
});
