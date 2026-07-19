import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { TaskStore } from "@fusion/core";
import { __test__, buildAutostashLabel } from "../merger.js";

const { sweepAutostashOrphans, parseAutostashTaskId, listAutostashOrphans } = __test__;

/*
FNXC:MergeAutostash 2026-07-15-13:20:
Real git, not mocks: the defect under test is a property of git's own stash
object model — `--include-untracked` puts untracked files in a third parent
(`<sha>^3`) that `git stash show` omits — so a mocked git can neither express nor
catch it. Reading only the tracked side made an untracked-only stash look empty,
and empty was treated as "subsumed → safe to drop", silently destroying work.

Asserts the invariant across ALL stash shapes rather than the single reported
case (FN-5893): tracked-only, untracked-only, and mixed, each in both live and
subsumed states. The mixed/live-untracked shape is the one that regressed —
tracked side subsumed, untracked side live — because a tracked-only reader drops
it and takes the untracked work with it.
*/

function git(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString("utf-8").trim();
}

function initRepo(dir: string): void {
  git(dir, "git init -b main");
  git(dir, 'git config user.email "test@example.com"');
  git(dir, 'git config user.name "Test"');
  writeFileSync(join(dir, "file.txt"), "base\n");
  git(dir, "git add file.txt");
  git(dir, 'git commit -m "init"');
}

function stashList(dir: string): string {
  return git(dir, 'git stash list --format="%H %gd %s"');
}

function testTempParent(): string {
  return process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir();
}

function assertIsolatedWorkspace(dir: string): void {
  const repoRoot = process.env.FUSION_TEST_REAL_ROOT;
  if (!repoRoot) return;
  expect(resolve(dir).startsWith(resolve(repoRoot))).toBe(false);
}

/** Store whose tasks are all live, so orphan retention is decided purely by
 *  stash content rather than by the closed-task drop path. */
function makeStore(): TaskStore {
  return {
    getTask: async (taskId: string) => ({ id: taskId, column: "in-progress" }) as never,
    logEntry: async () => undefined,
  } as unknown as TaskStore;
}

/** Stash the working tree under a canonical label, including untracked files. */
function pushAutostash(dir: string, taskId: string, phase = "ai-local-sync"): string {
  const label = buildAutostashLabel(taskId, phase, Date.now());
  git(dir, `git stash push --include-untracked -m ${JSON.stringify(label)}`);
  return git(dir, 'git stash list --format="%H" -n 1');
}

describe("autostash reclamation — untracked content (real git)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(testTempParent(), "fusion-test-autostash-untracked-"));
    assertIsolatedWorkspace(dir);
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("retains an untracked-only stash whose file is absent from HEAD", async () => {
    writeFileSync(join(dir, "new-plan.md"), "unrecovered work\n");
    const sha = pushAutostash(dir, "FN-6001");

    await sweepAutostashOrphans(dir, "FN-9999", makeStore());

    expect(stashList(dir)).toContain(sha);
  });

  it("reports an untracked-only stash's paths rather than an empty list", async () => {
    writeFileSync(join(dir, "new-plan.md"), "unrecovered work\n");
    pushAutostash(dir, "FN-6002");

    const [record] = await listAutostashOrphans(dir);

    expect(record?.changedPaths).toContain("new-plan.md");
    expect(record?.classification).toBe("live");
  });

  it("retains a mixed stash whose tracked side is subsumed but untracked side is not", async () => {
    // Tracked edit lands on HEAD (subsumed); untracked file never does (live).
    writeFileSync(join(dir, "file.txt"), "landed\n");
    writeFileSync(join(dir, "orphan-test.ts"), "still only in the stash\n");
    const sha = pushAutostash(dir, "FN-6003");
    writeFileSync(join(dir, "file.txt"), "landed\n");
    git(dir, "git add file.txt");
    git(dir, 'git commit -m "land the tracked edit"');

    await sweepAutostashOrphans(dir, "FN-9999", makeStore());

    expect(stashList(dir)).toContain(sha);
  });

  it("drops a stash once BOTH its tracked and untracked content are on HEAD", async () => {
    writeFileSync(join(dir, "file.txt"), "landed\n");
    writeFileSync(join(dir, "added.ts"), "landed too\n");
    const sha = pushAutostash(dir, "FN-6004");
    writeFileSync(join(dir, "file.txt"), "landed\n");
    writeFileSync(join(dir, "added.ts"), "landed too\n");
    git(dir, "git add file.txt added.ts");
    git(dir, 'git commit -m "land both"');

    await sweepAutostashOrphans(dir, "FN-9999", makeStore());

    expect(stashList(dir)).not.toContain(sha);
  });

  it("retains a tracked-only stash that still differs from HEAD", async () => {
    writeFileSync(join(dir, "file.txt"), "uncommitted edit\n");
    const sha = pushAutostash(dir, "FN-6005");

    await sweepAutostashOrphans(dir, "FN-9999", makeStore());

    expect(stashList(dir)).toContain(sha);
  });
});

describe("autostash reclamation — merger-ai label vocabulary", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(testTempParent(), "fusion-test-autostash-ai-label-"));
    assertIsolatedWorkspace(dir);
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses the task id from a legacy fusion-ai-merge-sync label", () => {
    expect(parseAutostashTaskId("fusion-ai-merge-sync-FN-7790")).toBe("FN-7790");
    expect(parseAutostashTaskId("fusion-ai-merge-sync-")).toBeNull();
    expect(parseAutostashTaskId("fusion-ai-merge-sync-nope")).toBeNull();
  });

  it("builds an ai-local-sync label the canonical parsers accept", () => {
    const label = buildAutostashLabel("FN-7790", "ai-local-sync", 1_700_000_000_000);
    expect(label).toBe("fusion-merger-autostash:FN-7790:ai-local-sync:1700000000000");
    expect(parseAutostashTaskId(label)).toBe("FN-7790");
  });

  /*
  The leak itself: a legacy-labelled stash was invisible to every reclamation
  path, so it accumulated forever even once its content was fully on HEAD.
  */
  it("reclaims a legacy-labelled stash once its content is on HEAD", async () => {
    writeFileSync(join(dir, "file.txt"), "landed\n");
    git(dir, 'git stash push --include-untracked -m "fusion-ai-merge-sync-FN-7790"');
    const sha = git(dir, 'git stash list --format="%H" -n 1');
    writeFileSync(join(dir, "file.txt"), "landed\n");
    git(dir, "git add file.txt");
    git(dir, 'git commit -m "land it"');

    await sweepAutostashOrphans(dir, "FN-9999", makeStore());

    expect(stashList(dir)).not.toContain(sha);
  });

  it("retains a legacy-labelled stash that still holds unrecovered work", async () => {
    writeFileSync(join(dir, "file.txt"), "never landed\n");
    git(dir, 'git stash push --include-untracked -m "fusion-ai-merge-sync-FN-7791"');
    const sha = git(dir, 'git stash list --format="%H" -n 1');

    await sweepAutostashOrphans(dir, "FN-9999", makeStore());

    expect(stashList(dir)).toContain(sha);
  });
});
