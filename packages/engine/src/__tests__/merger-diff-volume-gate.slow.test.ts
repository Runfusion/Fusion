// Real-git wallclock under parallel CI load; do not lower per-test timeouts
// without re-measuring under pnpm test:full. (FN-4839)
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { DEFAULT_SETTINGS } from "@fusion/core";
import { checkDiffVolume, DiffVolumeRegressionError } from "../merger-diff-volume-gate.js";
import { attemptWithSideStrategy, commitOrAmendMergeWithFixes, executeMergeAttempt } from "../merger.js";

function git(dir: string, command: string): string {
  return execSync(command, { cwd: dir, stdio: "pipe" }).toString().trim();
}

function testTempParent(): string {
  return process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir();
}

function assertIsolatedWorkspace(dir: string): void {
  const repoRoot = process.env.FUSION_TEST_REAL_ROOT;
  if (!repoRoot) return;
  expect(resolve(dir).startsWith(resolve(repoRoot))).toBe(false);
}

function initRepo(dir: string): void {
  git(dir, "git init -b main");
  git(dir, 'git config user.email "test@example.com"');
  git(dir, 'git config user.name "Test"');
  git(dir, 'git config commit.gpgsign false');
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, "git add README.md");
  git(dir, 'git commit -m "chore: initial commit"');
}

function writeRepeatedLines(dir: string, file: string, count: number, prefix = "line"): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n") + "\n");
}

function discardStagedFile(dir: string, file: string): void {
  git(dir, `git reset HEAD -- ${file}`);
  const absolute = join(dir, file);
  if (existsSync(absolute)) {
    rmSync(absolute, { force: true });
  }
}

function createBranchCommit(dir: string, branch: string, file: string, lineCount: number, prefix?: string): { preAttemptHeadSha: string } {
  const preAttemptHeadSha = git(dir, "git rev-parse HEAD");
  git(dir, `git checkout -b ${branch}`);
  writeRepeatedLines(dir, file, lineCount, prefix ?? branch);
  git(dir, `git add ${file}`);
  git(dir, `git commit -m "feat: update ${file}"`);
  git(dir, "git checkout main");
  return { preAttemptHeadSha };
}

function stageSquash(dir: string, branch: string): void {
  git(dir, `git merge --squash ${branch}`);
}

function createMockStore() {
  return {
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue({ id: "FN-4072", column: "in-review", prompt: "# test" }),
    upsertTaskCommitAssociation: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, commitAuthorEnabled: false }),
  } as any;
}

function mergeAttemptParams(dir: string, branch: string, preAttemptHeadSha: string, store = createMockStore()) {
  return {
    store,
    rootDir: dir,
    taskId: "FN-4072",
    branch,
    commitLog: `- feat: ${branch}`,
    diffStat: "1 file changed",
    aiSummary: null,
    aiSubject: null,
    includeTaskId: false,
    smartConflictResolution: true,
    mergeConflictStrategy: "smart-prefer-main",
    attemptNum: 3,
    options: {},
    result: {},
    settings: { ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, commitAuthorEnabled: false },
    preAttemptHeadSha,
  } as any;
}

describe("checkDiffVolume", () => {
  const createdDirs = new Set<string>();

  afterEach(() => {
    for (const dir of createdDirs) {
      rmSync(dir, { recursive: true, force: true });
      createdDirs.delete(dir);
    }
  });

  it("blocks when a large branch contribution is dropped from staged content", async () => {
    const dir = mkdtempSync(join(testTempParent(), "fusion-test-diff-volume-"));
    createdDirs.add(dir);
    assertIsolatedWorkspace(dir);
    initRepo(dir);
    const { preAttemptHeadSha } = createBranchCommit(dir, "feat/drop", "packages/core/src/store.ts", 60, "drop");
    stageSquash(dir, "feat/drop");
    discardStagedFile(dir, "packages/core/src/store.ts");

    await expect(checkDiffVolume({
      rootDir: dir,
      branch: "feat/drop",
      integrationTargetSha: preAttemptHeadSha,
      minLines: 20,
      threshold: 0.2,
      allowlistGlobs: [],
      taskId: "FN-4072",
    })).rejects.toMatchObject({
      name: "DiffVolumeRegressionError",
      findings: [expect.objectContaining({ file: "packages/core/src/store.ts", branchNet: 60, staged: 0 })],
    });
  }, 15_000);

  it("ignores dropped files below minLines", async () => {
    const dir = mkdtempSync(join(testTempParent(), "fusion-test-diff-volume-"));
    createdDirs.add(dir);
    initRepo(dir);
    const { preAttemptHeadSha } = createBranchCommit(dir, "feat/small", "src/small.ts", 5, "small");
    stageSquash(dir, "feat/small");
    discardStagedFile(dir, "src/small.ts");

    await expect(checkDiffVolume({
      rootDir: dir,
      branch: "feat/small",
      integrationTargetSha: preAttemptHeadSha,
      minLines: 20,
      threshold: 0.2,
      allowlistGlobs: [],
      taskId: "FN-4072",
    })).resolves.toBeUndefined();
  });

  it("skips dropped lockfiles", async () => {
    const dir = mkdtempSync(join(testTempParent(), "fusion-test-diff-volume-"));
    createdDirs.add(dir);
    initRepo(dir);
    const { preAttemptHeadSha } = createBranchCommit(dir, "feat/lock", "pnpm-lock.yaml", 60, "lock");
    stageSquash(dir, "feat/lock");
    discardStagedFile(dir, "pnpm-lock.yaml");

    await expect(checkDiffVolume({
      rootDir: dir,
      branch: "feat/lock",
      integrationTargetSha: preAttemptHeadSha,
      minLines: 20,
      threshold: 0.2,
      allowlistGlobs: [],
      taskId: "FN-4072",
    })).resolves.toBeUndefined();
  });

  it("honors caller-supplied allowlist globs", async () => {
    const dir = mkdtempSync(join(testTempParent(), "fusion-test-diff-volume-"));
    createdDirs.add(dir);
    initRepo(dir);
    const { preAttemptHeadSha } = createBranchCommit(dir, "feat/allow", "fixtures/generated.snapshot", 60, "snapshot");
    stageSquash(dir, "feat/allow");
    discardStagedFile(dir, "fixtures/generated.snapshot");

    await expect(checkDiffVolume({
      rootDir: dir,
      branch: "feat/allow",
      integrationTargetSha: preAttemptHeadSha,
      minLines: 20,
      threshold: 0.2,
      allowlistGlobs: ["fixtures/*.snapshot"],
      taskId: "FN-4072",
    })).resolves.toBeUndefined();
  });

  it("treats binary numstat entries as zero without crashing", async () => {
    const dir = mkdtempSync(join(testTempParent(), "fusion-test-diff-volume-"));
    createdDirs.add(dir);
    initRepo(dir);
    const preAttemptHeadSha = git(dir, "git rev-parse HEAD");
    git(dir, "git checkout -b feat/binary");
    writeFileSync(join(dir, "image.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
    git(dir, "git add image.bin");
    git(dir, 'git commit -m "feat: add binary"');
    git(dir, "git checkout main");
    stageSquash(dir, "feat/binary");
    discardStagedFile(dir, "image.bin");

    await expect(checkDiffVolume({
      rootDir: dir,
      branch: "feat/binary",
      integrationTargetSha: preAttemptHeadSha,
      minLines: 1,
      threshold: 0.2,
      allowlistGlobs: [],
      taskId: "FN-4072",
    })).resolves.toBeUndefined();
  });

  it("exposes a structured error message", async () => {
    const dir = mkdtempSync(join(testTempParent(), "fusion-test-diff-volume-"));
    createdDirs.add(dir);
    initRepo(dir);
    const { preAttemptHeadSha } = createBranchCommit(dir, "feat/msg", "src/important.ts", 60, "important");
    stageSquash(dir, "feat/msg");
    discardStagedFile(dir, "src/important.ts");

    await expect(checkDiffVolume({
      rootDir: dir,
      branch: "feat/msg",
      integrationTargetSha: preAttemptHeadSha,
      minLines: 20,
      threshold: 0.2,
      allowlistGlobs: [],
      taskId: "FN-4072",
    })).rejects.toSatisfy((error: unknown) => error instanceof DiffVolumeRegressionError && error.message.includes("branch_net=60") && error.message.includes("ratio=0.000"));
  });
});

describe("diff-volume gate merger integration", () => {
  const createdDirs = new Set<string>();

  afterEach(() => {
    for (const dir of createdDirs) {
      rmSync(dir, { recursive: true, force: true });
      createdDirs.delete(dir);
    }
  });

  it("blocks the FN-3936 replay in attemptWithSideStrategy and leaves the worktree clean", async () => {
    const dir = mkdtempSync(join(testTempParent(), "fusion-test-diff-volume-merge-"));
    createdDirs.add(dir);
    initRepo(dir);
    writeRepeatedLines(dir, "packages/core/src/store.ts", 1, "base");
    git(dir, "git add packages/core/src/store.ts");
    git(dir, 'git commit -m "chore: add store"');

    git(dir, "git checkout -b feat/fn-3936");
    writeRepeatedLines(dir, "packages/core/src/store.ts", 60, "branch");
    writeRepeatedLines(dir, "docs/kept.md", 5, "kept");
    git(dir, "git add packages/core/src/store.ts docs/kept.md");
    git(dir, 'git commit -m "feat: branch store hardening"');
    git(dir, "git checkout main");

    writeRepeatedLines(dir, "packages/core/src/store.ts", 1, "main");
    git(dir, "git add packages/core/src/store.ts");
    git(dir, 'git commit -m "fix: main store edit"');
    const mainHeadBeforeMerge = git(dir, "git rev-parse HEAD");

    const store = createMockStore();
    await expect(attemptWithSideStrategy(mergeAttemptParams(dir, "feat/fn-3936", mainHeadBeforeMerge, store), "ours")).rejects.toMatchObject({
      name: "DiffVolumeRegressionError",
      findings: [expect.objectContaining({ file: "packages/core/src/store.ts", branchNet: 61, staged: 0 })],
    });

    expect(git(dir, "git rev-parse HEAD")).toBe(mainHeadBeforeMerge);
    expect(git(dir, "git status --short")).toBe("");
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-4072",
      "Diff-volume gate blocked auto-resolved squash before commit",
      "tool_error",
      expect.stringContaining("packages/core/src/store.ts"),
      "merger",
    );
  });

  it("allows a healthy attempt 2 auto-resolution path when staged volume matches the branch", async () => {
    const dir = mkdtempSync(join(testTempParent(), "fusion-test-diff-volume-merge-"));
    createdDirs.add(dir);
    initRepo(dir);
    writeRepeatedLines(dir, "src/data.gen.ts", 1, "base");
    git(dir, "git add src/data.gen.ts");
    git(dir, 'git commit -m "chore: add generated file"');
    const preAttemptHeadSha = git(dir, "git rev-parse HEAD");

    git(dir, "git checkout -b feat/generated");
    writeRepeatedLines(dir, "src/data.gen.ts", 60, "branch-generated");
    git(dir, "git add src/data.gen.ts");
    git(dir, 'git commit -m "feat: regenerate data"');
    git(dir, "git checkout main");

    writeRepeatedLines(dir, "src/data.gen.ts", 2, "main-generated");
    git(dir, "git add src/data.gen.ts");
    git(dir, 'git commit -m "chore: main regen"');
    const store = createMockStore();

    const success = await executeMergeAttempt({
      ...mergeAttemptParams(dir, "feat/generated", preAttemptHeadSha, store),
      attemptNum: 2,
      diffStat: " src/data.gen.ts | 60 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++",
    }, {} as any);

    expect(success).toBe(true);
    expect(git(dir, "git rev-parse HEAD")).not.toBe(preAttemptHeadSha);
    expect(git(dir, "git show --format= --name-only HEAD").split("\n")).toContain("src/data.gen.ts");
  }, 15_000);

  it("allows dropped lockfile-only content in attemptWithSideStrategy", async () => {
    const dir = mkdtempSync(join(testTempParent(), "fusion-test-diff-volume-merge-"));
    createdDirs.add(dir);
    initRepo(dir);
    writeRepeatedLines(dir, "pnpm-lock.yaml", 1, "base-lock");
    git(dir, "git add pnpm-lock.yaml");
    git(dir, 'git commit -m "chore: add lockfile"');

    git(dir, "git checkout -b feat/lock-drop");
    writeRepeatedLines(dir, "pnpm-lock.yaml", 60, "branch-lock");
    writeRepeatedLines(dir, "src/kept.ts", 5, "kept-lock");
    git(dir, "git add pnpm-lock.yaml src/kept.ts");
    git(dir, 'git commit -m "feat: lock update"');
    git(dir, "git checkout main");

    writeRepeatedLines(dir, "pnpm-lock.yaml", 1, "main-lock");
    git(dir, "git add pnpm-lock.yaml");
    git(dir, 'git commit -m "chore: main lock change"');
    const mainHeadBeforeMerge = git(dir, "git rev-parse HEAD");

    const merged = await attemptWithSideStrategy(mergeAttemptParams(dir, "feat/lock-drop", mainHeadBeforeMerge), "ours");
    expect(merged).toBe(true);
    expect(git(dir, "git rev-parse HEAD")).not.toBe(mainHeadBeforeMerge);
  });

  it("blocks commitOrAmendMergeWithFixes before a fresh finalize commit when staged branch volume was dropped", async () => {
    const dir = mkdtempSync(join(testTempParent(), "fusion-test-diff-volume-merge-"));
    createdDirs.add(dir);
    initRepo(dir);
    const preAttemptHeadSha = git(dir, "git rev-parse HEAD");
    git(dir, "git checkout -b feat/finalize-fresh");
    writeRepeatedLines(dir, "src/finalize.ts", 60, "fresh");
    writeRepeatedLines(dir, "src/kept.ts", 5, "kept-fresh");
    git(dir, "git add src/finalize.ts src/kept.ts");
    git(dir, 'git commit -m "feat: finalize fresh"');
    git(dir, "git checkout main");
    stageSquash(dir, "feat/finalize-fresh");
    discardStagedFile(dir, "src/finalize.ts");

    await expect(commitOrAmendMergeWithFixes(
      dir,
      "FN-4072",
      "feat/finalize-fresh",
      "- feat: finalize fresh",
      false,
      preAttemptHeadSha,
      "",
      "1 file changed",
      { ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, commitAuthorEnabled: false },
      undefined,
      null,
      null,
      new Set<string>(),
      createMockStore(),
    )).rejects.toBeInstanceOf(DiffVolumeRegressionError);

    expect(git(dir, "git rev-parse HEAD")).toBe(preAttemptHeadSha);
    expect(git(dir, "git status --short")).toBe("");
  });

  it("blocks commitOrAmendMergeWithFixes before an amend finalize when staged branch volume was dropped", async () => {
    const dir = mkdtempSync(join(testTempParent(), "fusion-test-diff-volume-merge-"));
    createdDirs.add(dir);
    initRepo(dir);
    const preAttemptHeadSha = git(dir, "git rev-parse HEAD");
    git(dir, "git checkout -b feat/finalize-amend");
    writeRepeatedLines(dir, "src/amend.ts", 60, "amend");
    writeRepeatedLines(dir, "src/kept-amend.ts", 5, "kept-amend");
    git(dir, "git add src/amend.ts src/kept-amend.ts");
    git(dir, 'git commit -m "feat: finalize amend"');
    git(dir, "git checkout main");
    stageSquash(dir, "feat/finalize-amend");
    git(dir, 'git commit -m "feat: ai commit"');
    writeRepeatedLines(dir, "README.md", 1, "dirty");
    git(dir, "git add README.md");
    git(dir, "git reset HEAD -- src/amend.ts");
    rmSync(join(dir, "src/amend.ts"), { force: true });

    await expect(commitOrAmendMergeWithFixes(
      dir,
      "FN-4072",
      "feat/finalize-amend",
      "- feat: finalize amend",
      false,
      preAttemptHeadSha,
      "",
      "1 file changed",
      { ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, commitAuthorEnabled: false },
      undefined,
      null,
      null,
      new Set<string>(["README.md"]),
      createMockStore(),
    )).rejects.toBeInstanceOf(DiffVolumeRegressionError);

    expect(git(dir, "git rev-parse HEAD")).toBe(preAttemptHeadSha);
    expect(git(dir, "git status --short")).toBe("");
  });
});
