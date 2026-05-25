import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { RunAuditEventInput, TaskStore } from "@fusion/core";
import { createRunAuditor } from "../run-audit.js";
import { __test__ } from "../merger.js";

const { runMergeAdvanceAutoSync } = __test__;

function git(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString("utf-8").trim();
}

function testTempParent(): string {
  return process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir();
}

interface Fixture {
  root: string;
  upstream: string;
  projectRoot: string;
  taskWorktree: string;
  previousSha: string;
  newSha: string;
  recorded: RunAuditEventInput[];
  store: TaskStore;
}

function setupFixture(): Fixture {
  const root = mkdtempSync(join(testTempParent(), "merger-auto-sync-"));
  const upstream = join(root, "upstream.git");
  const projectRoot = join(root, "project");

  git(root, `git init --bare -b main "${upstream}"`);
  git(root, `git clone "${upstream}" "${projectRoot}"`);
  git(projectRoot, 'git config user.email "user@example.com"');
  git(projectRoot, 'git config user.name "User"');
  writeFileSync(join(projectRoot, "base.txt"), "v1\n");
  git(projectRoot, "git add base.txt");
  git(projectRoot, 'git commit -m "init"');
  git(projectRoot, "git push -u origin main");
  const previousSha = git(projectRoot, "git rev-parse HEAD");

  // Build a task worktree on a fusion/fn-X branch and add a commit there —
  // this emulates the merger's task worktree. Then advance refs/heads/main
  // locally (no origin push) to that commit, leaving projectRoot's index +
  // working tree pinned to `previousSha` while HEAD now resolves to `newSha`.
  const taskWorktree = join(root, "task");
  git(projectRoot, `git worktree add -b fusion/fn-test "${taskWorktree}"`);
  writeFileSync(join(taskWorktree, "feature.txt"), "task work\n");
  writeFileSync(join(taskWorktree, "base.txt"), "v2 from task\n");
  git(taskWorktree, "git add -A");
  git(taskWorktree, 'git commit -m "task commit"');
  const newSha = git(taskWorktree, "git rev-parse HEAD");
  git(projectRoot, `git update-ref refs/heads/main ${newSha}`);

  const recorded: RunAuditEventInput[] = [];
  const store = {
    recordRunAuditEvent: vi.fn(async (input: RunAuditEventInput) => {
      recorded.push(input);
    }),
  } as unknown as TaskStore;

  return { root, upstream, projectRoot, taskWorktree, previousSha, newSha, recorded, store };
}

function makeAudit(store: TaskStore, taskId: string) {
  return createRunAuditor(store, { runId: `run-${Date.now()}`, agentId: "merger", taskId, phase: "merge" });
}

describe("runMergeAdvanceAutoSync (post-local-ref-advance reconciliation)", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });
  afterEach(() => {
    try {
      rmSync(fx.root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("clean projectRoot: snaps index + worktree forward to newSha and emits outcome=clean-sync", async () => {
    await runMergeAdvanceAutoSync({
      store: fx.store,
      audit: makeAudit(fx.store, "FN-TEST-1"),
      taskId: "FN-TEST-1",
      projectRootDir: fx.projectRoot,
      integrationBranch: "main",
      previousSha: fx.previousSha,
      newSha: fx.newSha,
      mode: "stash-and-ff",
    });

    const autoSync = fx.recorded.filter((e) => e.mutationType === "merge:auto-sync");
    expect(autoSync).toHaveLength(1);
    expect(autoSync[0].metadata).toMatchObject({
      outcome: "clean-sync",
      worktreePath: realpathSync(fx.projectRoot),
    });

    // The actual fix: worktree files now match newSha's tree.
    expect(readFileSync(join(fx.projectRoot, "base.txt"), "utf-8")).toBe("v2 from task\n");
    expect(readFileSync(join(fx.projectRoot, "feature.txt"), "utf-8")).toBe("task work\n");
    // `git status` is now clean.
    expect(git(fx.projectRoot, "git status --porcelain=v1")).toBe("");
  });

  it("ff-only mode + real edits: skipped-dirty, worktree untouched, no destructive operations", async () => {
    writeFileSync(join(fx.projectRoot, "local.txt"), "user edit\n");

    await runMergeAdvanceAutoSync({
      store: fx.store,
      audit: makeAudit(fx.store, "FN-TEST-2"),
      taskId: "FN-TEST-2",
      projectRootDir: fx.projectRoot,
      integrationBranch: "main",
      previousSha: fx.previousSha,
      newSha: fx.newSha,
      mode: "ff-only",
    });

    const autoSync = fx.recorded.filter((e) => e.mutationType === "merge:auto-sync");
    expect(autoSync).toHaveLength(1);
    expect(autoSync[0].metadata).toMatchObject({ outcome: "skipped-dirty" });
    // worktree still pinned at previousSha — `base.txt` has the original v1.
    expect(readFileSync(join(fx.projectRoot, "base.txt"), "utf-8")).toBe("v1\n");
    // The untracked local file survives untouched.
    expect(readFileSync(join(fx.projectRoot, "local.txt"), "utf-8")).toBe("user edit\n");
  });

  it("stash-and-ff + real edits on a non-conflicting file: edits restored on top of newSha", async () => {
    // The user added a brand-new untracked file that doesn't conflict with
    // the task's changes. After auto-sync the worktree should be at newSha
    // AND the local file should still be present.
    writeFileSync(join(fx.projectRoot, "local.txt"), "user edit\n");

    await runMergeAdvanceAutoSync({
      store: fx.store,
      audit: makeAudit(fx.store, "FN-TEST-3"),
      taskId: "FN-TEST-3",
      projectRootDir: fx.projectRoot,
      integrationBranch: "main",
      previousSha: fx.previousSha,
      newSha: fx.newSha,
      mode: "stash-and-ff",
    });

    const autoSync = fx.recorded.filter((e) => e.mutationType === "merge:auto-sync");
    expect(autoSync).toHaveLength(1);
    expect(autoSync[0].metadata).toMatchObject({ outcome: "synced-with-edits-restored" });

    // Task's content landed.
    expect(readFileSync(join(fx.projectRoot, "base.txt"), "utf-8")).toBe("v2 from task\n");
    expect(readFileSync(join(fx.projectRoot, "feature.txt"), "utf-8")).toBe("task work\n");
    // Local untracked edit survived.
    expect(readFileSync(join(fx.projectRoot, "local.txt"), "utf-8")).toBe("user edit\n");
  });

  it("emits structured merge:auto-sync per worktree and skips task worktrees on a different branch", async () => {
    await runMergeAdvanceAutoSync({
      store: fx.store,
      audit: makeAudit(fx.store, "FN-TEST-4"),
      taskId: "FN-TEST-4",
      projectRootDir: fx.projectRoot,
      integrationBranch: "main",
      previousSha: fx.previousSha,
      newSha: fx.newSha,
      mode: "stash-and-ff",
    });

    const autoSync = fx.recorded.filter((e) => e.mutationType === "merge:auto-sync");
    expect(autoSync).toHaveLength(1);
    // Task worktree (on fusion/fn-test) is not in branchMap for `main`, so no
    // event mentions it.
    for (const event of autoSync) {
      expect(event.target).not.toBe(fx.taskWorktree);
    }
  });

  it("untracked file colliding with a newly-tracked path is NOT overwritten — merged content is preserved", async () => {
    // User has an untracked `feature.txt` (locally meaningful) BEFORE the
    // task merge. The task's commit adds `feature.txt` as a tracked file with
    // different content. Without the collision guard, the auto-sync would
    // clobber the merged version with the user's stale untracked bytes.
    writeFileSync(join(fx.projectRoot, "feature.txt"), "USER stale local\n");

    await runMergeAdvanceAutoSync({
      store: fx.store,
      audit: makeAudit(fx.store, "FN-COLLIDE"),
      taskId: "FN-COLLIDE",
      projectRootDir: fx.projectRoot,
      integrationBranch: "main",
      previousSha: fx.previousSha,
      newSha: fx.newSha,
      mode: "stash-and-ff",
    });

    // The merged version (from the task commit) must win.
    expect(readFileSync(join(fx.projectRoot, "feature.txt"), "utf-8")).toBe("task work\n");

    const autoSync = fx.recorded.filter((e) => e.mutationType === "merge:auto-sync");
    expect(autoSync).toHaveLength(1);
    // Auto-sync surfaces the collision as synced-with-pop-conflict so the
    // dashboard's existing conflict UI hooks fire.
    expect(autoSync[0].metadata).toMatchObject({
      outcome: "synced-with-pop-conflict",
      untrackedSkippedAsTracked: ["feature.txt"],
    });
  });

  it("apply --3way failure on a deleted/renamed file: conflictedFiles populated from patch header, not left empty", async () => {
    // Set up a scenario where the user edits a tracked file that the merge
    // deletes. `git apply --3way` fails without staging unmerged entries, so
    // --diff-filter=U would otherwise return []. The patch-header fallback
    // must surface the affected path.
    //
    // Build fresh fixture: project has `doomed.txt` at previousSha, user
    // edits it, task commit deletes it.
    rmSync(fx.root, { recursive: true, force: true });
    const root = mkdtempSync(join(testTempParent(), "merger-auto-sync-delete-"));
    const upstream = join(root, "upstream.git");
    const projectRoot = join(root, "project");
    const taskWorktree = join(root, "task");
    git(root, `git init --bare -b main "${upstream}"`);
    git(root, `git clone "${upstream}" "${projectRoot}"`);
    git(projectRoot, 'git config user.email "u@e.com"');
    git(projectRoot, 'git config user.name "U"');
    writeFileSync(join(projectRoot, "doomed.txt"), "v1\n");
    git(projectRoot, "git add doomed.txt");
    git(projectRoot, 'git commit -m "init"');
    git(projectRoot, "git push -u origin main");
    const previousSha = git(projectRoot, "git rev-parse HEAD");

    git(projectRoot, `git worktree add -b fusion/fn-test "${taskWorktree}"`);
    // Task commit deletes doomed.txt
    execSync(`rm "${join(taskWorktree, "doomed.txt")}"`);
    git(taskWorktree, "git add -A");
    git(taskWorktree, 'git commit -m "delete doomed"');
    const newSha = git(taskWorktree, "git rev-parse HEAD");
    git(projectRoot, `git update-ref refs/heads/main ${newSha}`);

    // User modified doomed.txt before merge
    writeFileSync(join(projectRoot, "doomed.txt"), "v1\nuser edit\n");

    const recorded: RunAuditEventInput[] = [];
    const store = {
      recordRunAuditEvent: vi.fn(async (input: RunAuditEventInput) => { recorded.push(input); }),
    } as unknown as TaskStore;

    try {
      await runMergeAdvanceAutoSync({
        store,
        audit: makeAudit(store, "FN-DELETED"),
        taskId: "FN-DELETED",
        projectRootDir: projectRoot,
        integrationBranch: "main",
        previousSha,
        newSha,
        mode: "stash-and-ff",
      });

      const autoSync = recorded.filter((e) => e.mutationType === "merge:auto-sync");
      expect(autoSync).toHaveLength(1);
      expect(autoSync[0].metadata).toMatchObject({ outcome: "synced-with-pop-conflict" });
      const metadata = autoSync[0].metadata as { conflictedFiles?: string[]; patchPath?: string };
      // Patch-header fallback must surface doomed.txt even though git apply
      // failed before staging any unmerged index entries.
      expect(metadata.conflictedFiles).toContain("doomed.txt");
      expect(typeof metadata.patchPath).toBe("string");
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("no other worktrees on integration branch → no audit emissions", async () => {
    await runMergeAdvanceAutoSync({
      store: fx.store,
      audit: makeAudit(fx.store, "FN-TEST-5"),
      taskId: "FN-TEST-5",
      projectRootDir: fx.projectRoot,
      integrationBranch: "nonexistent-branch",
      previousSha: fx.previousSha,
      newSha: fx.newSha,
      mode: "stash-and-ff",
    });
    expect(fx.recorded).toHaveLength(0);
  });
});
