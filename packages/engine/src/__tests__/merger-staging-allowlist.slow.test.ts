/**
 * Integration tests for the merger staging allowlist (real git repos).
 *
 * These tests do NOT mock child_process — they run real git commands against
 * temporary repositories created in the OS temp directory. This verifies the
 * exact behavior of `snapshotDirtyFiles` and `commitOrAmendMergeWithFixes`
 * against a real git index without the indirection of exec mocks.
 *
 * Test inventory:
 *   1. snapshotDirtyFiles captures tracked-unstaged, staged, and untracked files
 *   2. Unrelated dirty file is excluded — not staged, warn emitted
 *   3. Fix-modified file is included — staged and committed
 *   4. File in squash + further edited by fix agent — staged once, no error
 *   5. Untracked file created by fix agent — staged and committed
 *   6. Untracked file pre-existing in working tree (user WIP) — NOT staged
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { snapshotDirtyFiles, commitOrAmendMergeWithFixes } from "../merger.js";
import { mergerLog } from "../logger.js";
import { DEFAULT_SETTINGS } from "@fusion/core";

// ---------------------------------------------------------------------------
// Git repo helpers
// ---------------------------------------------------------------------------

/**
 * Initialise a bare minimum git repo at `dir` with a single initial commit.
 * Returns the SHA of that commit (used as `preAttemptHeadSha`).
 */
function initRepo(dir: string): string {
  const git = (cmd: string) =>
    execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();

  git("git init -b main");
  git('git config user.email "test@example.com"');
  git('git config user.name "Test"');
  git('git config commit.gpgsign false');

  // Create an initial commit so HEAD exists
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git("git add README.md");
  git('git commit -m "chore: initial commit"');

  return git("git rev-parse HEAD");
}

/**
 * Create a feature branch with one commit, then return to main and run
 * `git merge --squash <branch>` so that a squash is staged but not committed.
 * Returns the SHA of main's tip (which becomes `preAttemptHeadSha`).
 */
function squashBranch(dir: string, branchName: string, fileName: string, content: string): string {
  const git = (cmd: string) =>
    execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();

  git(`git checkout -b ${branchName}`);
  writeFileSync(join(dir, fileName), content);
  git(`git add ${fileName}`);
  git(`git commit -m "feat: add ${fileName}"`);
  git("git checkout main");

  const preAttemptSha = git("git rev-parse HEAD");

  git(`git merge --squash ${branchName}`);
  return preAttemptSha;
}

// ---------------------------------------------------------------------------
// Minimal stub settings / args used by commitOrAmendMergeWithFixes
// ---------------------------------------------------------------------------

function testTempParent(): string {
  return process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir();
}

function assertIsolatedWorkspace(dir: string): void {
  const repoRoot = process.env.FUSION_TEST_REAL_ROOT;
  if (!repoRoot) return;
  expect(resolve(dir).startsWith(resolve(repoRoot))).toBe(false);
}

const STUB_SETTINGS = {
  ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
  commitAuthorEnabled: false, // skip --author flag to avoid user config issues
};

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

afterAll(() => {
  for (const dir of Array.from(createdDirs)) {
    cleanupTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("snapshotDirtyFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(testTempParent(), "fusion-test-merger-snapshot-"));
    createdDirs.add(dir);
    assertIsolatedWorkspace(dir);
    initRepo(dir);
  });

  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("returns empty set when working tree is clean", async () => {
    const snapshot = await snapshotDirtyFiles(dir);
    expect(snapshot.size).toBe(0);
  });

  it("captures tracked-unstaged modifications", async () => {
    writeFileSync(join(dir, "README.md"), "modified\n");
    const snapshot = await snapshotDirtyFiles(dir);
    expect(snapshot.has("README.md")).toBe(true);
  });

  it("captures staged (cached) modifications", async () => {
    writeFileSync(join(dir, "README.md"), "staged change\n");
    execSync("git add README.md", { cwd: dir, stdio: "pipe" });
    const snapshot = await snapshotDirtyFiles(dir);
    expect(snapshot.has("README.md")).toBe(true);
  });

  it("captures untracked files", async () => {
    writeFileSync(join(dir, "new-file.ts"), "export const x = 1;\n");
    const snapshot = await snapshotDirtyFiles(dir);
    expect(snapshot.has("new-file.ts")).toBe(true);
  });

  it("captures all three categories simultaneously", async () => {
    // Tracked-unstaged
    writeFileSync(join(dir, "README.md"), "dirty\n");
    // Staged
    writeFileSync(join(dir, "staged.ts"), "const s = 1;\n");
    execSync("git add staged.ts", { cwd: dir, stdio: "pipe" });
    // Untracked
    writeFileSync(join(dir, "untracked.ts"), "const u = 2;\n");

    const snapshot = await snapshotDirtyFiles(dir);
    expect(snapshot.has("README.md")).toBe(true);
    expect(snapshot.has("staged.ts")).toBe(true);
    expect(snapshot.has("untracked.ts")).toBe(true);
  });

  it("returns empty set when rootDir is not a git repo (error swallowed)", async () => {
    const nonRepo = mkdtempSync(join(testTempParent(), "fusion-test-merger-non-repo-"));
    assertIsolatedWorkspace(nonRepo);
    try {
      const snapshot = await snapshotDirtyFiles(nonRepo);
      expect(snapshot.size).toBe(0);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

describe("commitOrAmendMergeWithFixes — staging allowlist", () => {
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(testTempParent(), "fusion-test-merger-allowlist-"));
    createdDirs.add(dir);
    assertIsolatedWorkspace(dir);
    initRepo(dir);
    warnSpy = vi.spyOn(mergerLog, "warn");
  });

  afterEach(() => {
    try {
      warnSpy.mockRestore();
    } finally {
      cleanupTempDir(dir);
    }
  });

  // ── Scenario 1: Unrelated dirty file is excluded ───────────────────────

  it("does not stage an unrelated dirty file and emits a warn", async () => {
    const preAttemptSha = squashBranch(dir, "feat/A", "feature-a.ts", "export const a = 1;\n");

    // Simulate user's unrelated WIP: a modified tracked file
    writeFileSync(join(dir, "README.md"), "user WIP — should not be committed\n");

    // fixModifiedFiles is empty — no fix agent ran
    const result = await commitOrAmendMergeWithFixes(
      dir,
      "FN-TEST",
      "feat/A",
      "- feat: add feature-a.ts",
      false,
      preAttemptSha,
      "",          // no --author flag
      undefined,
      STUB_SETTINGS,
      undefined,
      null,
      null,
      new Set<string>(), // empty fixModifiedFiles
    );

    expect(result).toEqual({ ok: true, reason: expect.any(String) });

    // The unrelated file must NOT appear in the commit
    const committedFiles = execSync("git diff --name-only HEAD~1 HEAD", {
      cwd: dir,
      stdio: "pipe",
    }).toString().trim().split("\n");
    expect(committedFiles).not.toContain("README.md");
    expect(committedFiles).toContain("feature-a.ts");

    // Warn must have been emitted for the excluded file
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnMessages.some((m) => m.includes("README.md") && m.includes("refusing to stage"))).toBe(true);

    // README.md must still be dirty in the working tree
    const status = execSync("git diff --name-only", { cwd: dir, stdio: "pipe" }).toString().trim();
    expect(status).toContain("README.md");
  });

  // ── Scenario 2: Fix-modified file is included ─────────────────────────

  it("stages a file that the fix agent modified", async () => {
    const preAttemptSha = squashBranch(dir, "feat/B", "feature-b.ts", "export const b = 1;\n");

    // Fix agent modified an additional file (tracked, unstaged)
    writeFileSync(join(dir, "README.md"), "fixed by agent\n");

    const result = await commitOrAmendMergeWithFixes(
      dir,
      "FN-TEST",
      "feat/B",
      "- feat: add feature-b.ts",
      false,
      preAttemptSha,
      "",
      undefined,
      STUB_SETTINGS,
      undefined,
      null,
      null,
      new Set(["README.md"]), // fix agent touched this
    );

    expect(result).toEqual({ ok: true, reason: expect.any(String) });

    const committedFiles = execSync("git diff --name-only HEAD~1 HEAD", {
      cwd: dir,
      stdio: "pipe",
    }).toString().trim().split("\n");
    expect(committedFiles).toContain("feature-b.ts");
    expect(committedFiles).toContain("README.md");

    // Working tree should be clean for README.md now
    const status = execSync("git diff --name-only", { cwd: dir, stdio: "pipe" }).toString().trim();
    expect(status).not.toContain("README.md");
  });

  // ── Scenario 3: Squash file further edited by fix agent ───────────────

  it("stages squash file with additional fix-agent edits only once", async () => {
    const preAttemptSha = squashBranch(dir, "feat/C", "feature-c.ts", "export const c = 1;\n");

    // Fix agent further edits the squash file (it's tracked-unstaged after squash staged it)
    writeFileSync(join(dir, "feature-c.ts"), "export const c = 2; // fixed\n");

    const result = await commitOrAmendMergeWithFixes(
      dir,
      "FN-TEST",
      "feat/C",
      "- feat: add feature-c.ts",
      false,
      preAttemptSha,
      "",
      undefined,
      STUB_SETTINGS,
      undefined,
      null,
      null,
      new Set(["feature-c.ts"]), // fix agent touched the same file the squash staged
    );

    expect(result).toEqual({ ok: true, reason: expect.any(String) });

    // The committed file must contain the fix agent's content, not the squash's
    const committedContent = execSync("git show HEAD:feature-c.ts", {
      cwd: dir,
      stdio: "pipe",
    }).toString();
    expect(committedContent).toContain("// fixed");

    // No double-staging error should have occurred (result is true)
    // Working tree should be clean
    const status = execSync("git status --porcelain", { cwd: dir, stdio: "pipe" }).toString().trim();
    expect(status).toBe("");
  });

  // ── Scenario 4: Untracked file created by fix agent ───────────────────

  it("stages an untracked file created by the fix agent", async () => {
    const preAttemptSha = squashBranch(dir, "feat/D", "feature-d.ts", "export const d = 1;\n");

    // Fix agent created a brand-new file (untracked)
    writeFileSync(join(dir, "new-fixture.ts"), "export const fixture = {};\n");

    const result = await commitOrAmendMergeWithFixes(
      dir,
      "FN-TEST",
      "feat/D",
      "- feat: add feature-d.ts",
      false,
      preAttemptSha,
      "",
      undefined,
      STUB_SETTINGS,
      undefined,
      null,
      null,
      new Set(["new-fixture.ts"]), // fix agent created this file
    );

    expect(result).toEqual({ ok: true, reason: expect.any(String) });

    const committedFiles = execSync("git diff --name-only HEAD~1 HEAD", {
      cwd: dir,
      stdio: "pipe",
    }).toString().trim().split("\n");
    expect(committedFiles).toContain("new-fixture.ts");
    expect(committedFiles).toContain("feature-d.ts");
  });

  // ── Scenario 5: Pre-existing untracked user WIP file not staged ────────

  it("does not stage a pre-existing untracked user WIP file", async () => {
    // Create untracked user WIP before squash (simulates pre-existing state)
    writeFileSync(join(dir, "user-wip.ts"), "// WIP — do not touch\n");

    const preAttemptSha = squashBranch(dir, "feat/E", "feature-e.ts", "export const e = 1;\n");

    // fixModifiedFiles does not include the user's WIP file
    const result = await commitOrAmendMergeWithFixes(
      dir,
      "FN-TEST",
      "feat/E",
      "- feat: add feature-e.ts",
      false,
      preAttemptSha,
      "",
      undefined,
      STUB_SETTINGS,
      undefined,
      null,
      null,
      new Set<string>(), // empty — the WIP file is not fix-agent-produced
    );

    expect(result).toEqual({ ok: true, reason: expect.any(String) });

    const committedFiles = execSync("git diff --name-only HEAD~1 HEAD", {
      cwd: dir,
      stdio: "pipe",
    }).toString().trim().split("\n");
    expect(committedFiles).not.toContain("user-wip.ts");
    expect(committedFiles).toContain("feature-e.ts");

    // The WIP file must still be untracked in the working tree
    const porcelain = execSync("git status --porcelain", {
      cwd: dir,
      stdio: "pipe",
    }).toString();
    expect(porcelain).toContain("user-wip.ts");

    // Warn must have been emitted
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnMessages.some((m) => m.includes("user-wip.ts") && m.includes("refusing to stage"))).toBe(true);
  });

  // ── Scenario 6: Mixed — fix file included, unrelated file excluded ─────

  it("stages fix-agent file but excludes a second unrelated file in the same pass", async () => {
    // Commit unrelated.ts into main so it is a properly tracked file
    writeFileSync(join(dir, "unrelated.ts"), "// original\n");
    execSync("git add unrelated.ts", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "chore: add unrelated.ts"', { cwd: dir, stdio: "pipe" });

    const preAttemptSha = squashBranch(dir, "feat/F", "feature-f.ts", "export const f = 1;\n");

    // Fix agent modified one file
    writeFileSync(join(dir, "README.md"), "agent fix\n");
    // User modified the tracked (but unrelated) file in the working tree
    writeFileSync(join(dir, "unrelated.ts"), "// user WIP\n");

    const result = await commitOrAmendMergeWithFixes(
      dir,
      "FN-TEST",
      "feat/F",
      "- feat: add feature-f.ts",
      false,
      preAttemptSha,
      "",
      undefined,
      STUB_SETTINGS,
      undefined,
      null,
      null,
      new Set(["README.md"]), // only the agent's file is in the allowlist
    );

    expect(result).toEqual({ ok: true, reason: expect.any(String) });

    const committedFiles = execSync("git diff --name-only HEAD~1 HEAD", {
      cwd: dir,
      stdio: "pipe",
    }).toString().trim().split("\n");
    expect(committedFiles).toContain("feature-f.ts");
    expect(committedFiles).toContain("README.md");
    expect(committedFiles).not.toContain("unrelated.ts");

    // unrelated.ts must remain dirty
    const dirty = execSync("git diff --name-only", { cwd: dir, stdio: "pipe" }).toString();
    expect(dirty).toContain("unrelated.ts");

    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnMessages.some((m) => m.includes("unrelated.ts") && m.includes("refusing to stage"))).toBe(true);
  });

  // ── Regression: phantom-merge guard false-negative ────────────────────
  //
  // Previously a stale `preAttemptHeadSha` (e.g. captured by a redundant
  // attempt 2 after attempt 1's AI commit) combined with a fix that touched
  // no tracked files would trip the phantom-merge guard and strand the task
  // in In Review even though the merge commit already landed on HEAD. The
  // guard now defers to the `Fusion-Task-Id` trailer: if HEAD already records
  // this task, treat the no-op finalize as success.
  it("returns success when HEAD already carries the Fusion-Task-Id trailer (phantom-merge false-negative defense)", async () => {
    const taskId = "FN-3727";
    const git = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" }).toString();

    // Simulate the state after attempt 1 successfully committed: HEAD carries
    // the Fusion-Task-Id trailer for this task; the working tree is clean.
    git("git checkout -b feat/Z");
    writeFileSync(join(dir, "feature-z.ts"), "export const z = 1;\n");
    git("git add feature-z.ts");
    git('git commit -m "feat: add feature-z" -m "Fusion-Task-Id: ' + taskId + '"');
    git("git checkout main");
    git("git merge --squash feat/Z");
    git('git commit -m "feat(' + taskId + '): add feature-z" -m "Fusion-Task-Id: ' + taskId + '"');

    // Now invoke the finalizer with a STALE baseline — preAttemptHeadSha
    // points at HEAD itself (mimicking attempt 2 capturing HEAD after
    // attempt 1's commit) and no fix-modified files.
    const headSha = git("git rev-parse HEAD").trim();
    const result = await commitOrAmendMergeWithFixes(
      dir,
      taskId,
      "feat/Z",
      "- feat: add feature-z",
      false,
      headSha, // stale baseline — equals current HEAD
      "",
      undefined,
      STUB_SETTINGS,
      undefined,
      null,
      null,
      new Set<string>(), // fix touched no tracked files
    );

    // Must NOT trip the phantom-merge guard: the trailer says we're done.
    expect(result).toEqual({ ok: true, reason: expect.any(String) });

    // No new commit should have been fabricated.
    const newHead = git("git rev-parse HEAD").trim();
    expect(newHead).toBe(headSha);
  });
});

// ---------------------------------------------------------------------------
// Embedded-space path tests — verify NUL-delimited parsing handles spaces
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Embedded-space path tests — verify NUL-delimited (-z) parsing handles spaces
//
// Note on untracked files in new subdirectories: git reports untracked entries
// at the outermost untracked directory level (e.g. `?? dir with space/`),
// not at the individual file level, when the directory itself is new. This is
// standard git behaviour regardless of -z. For that reason the untracked tests
// below use root-level files or files inside already-tracked directories,
// which are the cases that actually round-trip through `snapshotDirtyFiles`.
// ---------------------------------------------------------------------------

describe("snapshotDirtyFiles — paths with embedded spaces", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(testTempParent(), "fusion-test-merger-snapshot-spaces-"));
    assertIsolatedWorkspace(dir);
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures a root-level untracked file whose name contains spaces", async () => {
    // Root-level untracked files with spaces are reported verbatim by git (no quoting in -z mode).
    writeFileSync(join(dir, "my file with spaces.ts"), "export const x = 1;\n");

    const snapshot = await snapshotDirtyFiles(dir);
    expect(snapshot.has("my file with spaces.ts")).toBe(true);
  });

  it("captures a tracked-unstaged file in a subdirectory whose path contains spaces", async () => {
    // First commit the file so it is tracked (git diff reports full path including spaces).
    mkdirSync(join(dir, "src dir"), { recursive: true });
    writeFileSync(join(dir, "src dir", "my component.ts"), "export const v = 0;\n");
    execSync("git add .", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "chore: add spaced file"', { cwd: dir, stdio: "pipe" });

    // Now modify it without staging — git diff -z --name-only emits the full path NUL-terminated.
    writeFileSync(join(dir, "src dir", "my component.ts"), "export const v = 1;\n");

    const snapshot = await snapshotDirtyFiles(dir);
    expect(snapshot.has("src dir/my component.ts")).toBe(true);
  });

  it("captures a staged (cached) file in a subdirectory whose path contains spaces", async () => {
    // Create the parent so it is already tracked, then add a new file.
    mkdirSync(join(dir, "path with spaces"), { recursive: true });
    writeFileSync(join(dir, "path with spaces", "keeper.ts"), "export {};\n");
    execSync("git add .", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "chore: track dir"', { cwd: dir, stdio: "pipe" });

    // Now create a new file in the tracked dir and stage it.
    writeFileSync(join(dir, "path with spaces", "index.ts"), "export const i = 1;\n");
    execSync("git add .", { cwd: dir, stdio: "pipe" });

    const snapshot = await snapshotDirtyFiles(dir);
    // git diff -z --cached --name-only reports staged files with their full path.
    expect(snapshot.has("path with spaces/index.ts")).toBe(true);
  });
});

describe("commitOrAmendMergeWithFixes — embedded-space paths round-trip", () => {
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(testTempParent(), "fusion-test-merger-allowlist-spaces-"));
    createdDirs.add(dir);
    assertIsolatedWorkspace(dir);
    initRepo(dir);
    warnSpy = vi.spyOn(mergerLog, "warn");
  });

  afterEach(() => {
    try {
      warnSpy.mockRestore();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("stages and commits a tracked file edited by the fix agent whose path contains spaces", async () => {
    // Pre-commit the spaced file so it is a tracked path.
    mkdirSync(join(dir, "src components"), { recursive: true });
    writeFileSync(join(dir, "src components", "my widget.ts"), "export const w = 0;\n");
    execSync("git add .", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "chore: add spaced component"', { cwd: dir, stdio: "pipe" });

    const preAttemptSha = squashBranch(dir, "feat/G", "feature-g.ts", "export const g = 1;\n");

    // Fix agent modifies the tracked spaced file (tracked-unstaged after squash).
    const spacedPath = "src components/my widget.ts";
    writeFileSync(join(dir, "src components", "my widget.ts"), "export const w = 1; // fixed\n");

    const result = await commitOrAmendMergeWithFixes(
      dir,
      "FN-TEST",
      "feat/G",
      "- feat: add feature-g.ts",
      false,
      preAttemptSha,
      "",
      undefined,
      STUB_SETTINGS,
      undefined,
      null,
      null,
      new Set([spacedPath]), // fix agent touched this tracked file
    );

    expect(result).toEqual({ ok: true, reason: expect.any(String) });

    // Verify both the squash file and the spaced file were committed.
    const committedFiles = execSync("git diff --name-only HEAD~1 HEAD", {
      cwd: dir,
      stdio: "pipe",
    }).toString().trim().split("\n");
    expect(committedFiles).toContain("feature-g.ts");
    expect(committedFiles).toContain(spacedPath);

    // Working tree must be clean for the spaced file.
    const dirty = execSync("git diff --name-only", { cwd: dir, stdio: "pipe" }).toString();
    expect(dirty).not.toContain(spacedPath);
  });

  it("excludes an unrelated tracked file with spaces and emits a warn", async () => {
    // Commit a tracked file with spaces so it appears in git diff (not git status -z untracked).
    const spacedUnrelated = "user notes/scratch.ts";
    mkdirSync(join(dir, "user notes"), { recursive: true });
    writeFileSync(join(dir, "user notes", "scratch.ts"), "// original\n");
    execSync("git add .", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "chore: add user notes"', { cwd: dir, stdio: "pipe" });

    const preAttemptSha = squashBranch(dir, "feat/H", "feature-h.ts", "export const h = 1;\n");

    // User edits their tracked spaced file — not in the allowlist.
    writeFileSync(join(dir, "user notes", "scratch.ts"), "// user WIP\n");

    const result = await commitOrAmendMergeWithFixes(
      dir,
      "FN-TEST",
      "feat/H",
      "- feat: add feature-h.ts",
      false,
      preAttemptSha,
      "",
      undefined,
      STUB_SETTINGS,
      undefined,
      null,
      null,
      new Set<string>(), // empty allowlist
    );

    expect(result).toEqual({ ok: true, reason: expect.any(String) });

    const committedFiles = execSync("git diff --name-only HEAD~1 HEAD", {
      cwd: dir,
      stdio: "pipe",
    }).toString().trim().split("\n");
    expect(committedFiles).toContain("feature-h.ts");
    expect(committedFiles).not.toContain(spacedUnrelated);

    // The file must still be dirty in the working tree.
    const dirty = execSync("git diff --name-only", { cwd: dir, stdio: "pipe" }).toString();
    expect(dirty).toContain(spacedUnrelated);

    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      warnMessages.some((m) => m.includes(spacedUnrelated) && m.includes("refusing to stage")),
    ).toBe(true);
  });
});
