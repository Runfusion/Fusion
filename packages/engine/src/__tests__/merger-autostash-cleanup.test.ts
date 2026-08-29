import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { TaskStore } from "@fusion/core";
import { __test__ } from "../merger.js";

const { sweepAutostashOrphans, parseAutostashTaskId, sweepStaleAutostashes, dropAutostashHandle } = __test__;

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

function createAutostash(dir: string, taskId: string, content: string): string {
  const label = `fusion-merger-autostash:${taskId}:${Date.now()}`;
  writeFileSync(join(dir, "file.txt"), content);
  git(dir, "git add file.txt");
  const sha = git(dir, "git stash create");
  git(dir, `git stash store -m ${JSON.stringify(label)} ${sha}`);
  git(dir, "git reset --hard HEAD");

  const list = stashList(dir);
  if (!list.includes(label)) {
    // Older git versions may ignore `stash store -m` for create/store objects.
    git(dir, "git stash drop stash@{0}");
    writeFileSync(join(dir, "file.txt"), content);
    git(dir, `git stash push -m ${JSON.stringify(label)} file.txt`);
    return git(dir, 'git stash list --format="%H" -n 1');
  }
  return sha;
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

function makeStore(tasks: Record<string, string>, opts?: { throwOnGetTask?: boolean }): TaskStore {
  return {
    getTask: async (taskId: string) => {
      if (opts?.throwOnGetTask) throw new Error("boom");
      const column = tasks[taskId];
      if (!column) return null;
      return { id: taskId, column } as any;
    },
    logEntry: async () => undefined,
  } as unknown as TaskStore;
}

describe("parseAutostashTaskId", () => {
  it("parses valid labels and rejects malformed/foreign labels", () => {
    expect(parseAutostashTaskId("fusion-merger-autostash:FN-3485:123")).toBe("FN-3485");
    expect(parseAutostashTaskId("fusion-merger-autostash:FN-3485")).toBeNull();
    expect(parseAutostashTaskId("fusion-merger-autostash::123")).toBeNull();
    expect(parseAutostashTaskId("WIP on main: abcdef")).toBeNull();
  });
});

describe("sweepStaleAutostashes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(testTempParent(), "fusion-test-merger-autostash-stale-"));
    assertIsolatedWorkspace(dir);
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("drops stale autostashes older than maxAgeMs", async () => {
    const oldTs = Date.now() - 26 * 60 * 60 * 1000;
    const staleLabel = `fusion-merger-autostash:FN-5001:${oldTs}`;
    writeFileSync(join(dir, "file.txt"), "stale\n");
    git(dir, `git stash push -m ${JSON.stringify(staleLabel)} file.txt`);

    const res = await sweepStaleAutostashes(dir, { maxAgeMs: 24 * 60 * 60 * 1000 });

    expect(res.dropped).toBe(1);
    expect(stashList(dir)).not.toContain("fusion-merger-autostash:FN-5001");
  });

  it("keeps recent autostashes within maxAgeMs", async () => {
    const freshLabel = `fusion-merger-autostash:FN-5002:${Date.now()}`;
    writeFileSync(join(dir, "file.txt"), "fresh\n");
    git(dir, `git stash push -m ${JSON.stringify(freshLabel)} file.txt`);

    const res = await sweepStaleAutostashes(dir, { maxAgeMs: 24 * 60 * 60 * 1000 });

    expect(res.dropped).toBe(0);
    expect(stashList(dir)).toContain("fusion-merger-autostash:FN-5002");
  });

  it("ignores non-fusion stash labels", async () => {
    writeFileSync(join(dir, "file.txt"), "manual\n");
    git(dir, "git stash push -m \"manual\" file.txt");

    const res = await sweepStaleAutostashes(dir, { maxAgeMs: 1 });

    expect(res.dropped).toBe(0);
    expect(stashList(dir)).toContain("manual");
  });

  it("tolerates malformed autostash labels", async () => {
    const malformed = "fusion-merger-autostash:FN-5003:not-a-timestamp";
    writeFileSync(join(dir, "file.txt"), "bad\n");
    git(dir, `git stash push -m ${JSON.stringify(malformed)} file.txt`);

    await expect(sweepStaleAutostashes(dir, { maxAgeMs: 1 })).resolves.toEqual({ dropped: 0 });
    expect(stashList(dir)).toContain("not-a-timestamp");
  });

  it("dropAutostashHandle drops primary and rescue shas", async () => {
    const pLabel = `fusion-merger-autostash:FN-5004:${Date.now() - 1000}`;
    writeFileSync(join(dir, "file.txt"), "primary\n");
    git(dir, `git stash push -m ${JSON.stringify(pLabel)} file.txt`);
    const primarySha = git(dir, 'git stash list --format="%H" -n 1');

    const rLabel = `fusion-merger-autostash:FN-5004:race-rescue-0:${Date.now() - 500}`;
    writeFileSync(join(dir, "file.txt"), "rescue\n");
    git(dir, `git stash push -m ${JSON.stringify(rLabel)} file.txt`);
    const rescueSha = git(dir, 'git stash list --format="%H" -n 1');

    const result = await dropAutostashHandle(dir, "FN-5004", {
      sha: primarySha,
      label: pLabel,
      rescueShas: [{ sha: rescueSha, label: rLabel }],
    }, { keepIfLive: false });

    expect(result.dropped).toBe(2);
    expect(stashList(dir)).toBe("");
  });
});

describe("sweepAutostashOrphans", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(testTempParent(), "fusion-test-merger-autostash-"));
    assertIsolatedWorkspace(dir);
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("drops closed-task done orphan when net diff is empty", async () => {
    createAutostash(dir, "FN-1001", "done-content\n");
    writeFileSync(join(dir, "file.txt"), "done-content\n");
    git(dir, "git add file.txt");
    git(dir, 'git commit -m "match stash"');

    await sweepAutostashOrphans(dir, "FN-MERGE", makeStore({ "FN-1001": "done" }));

    expect(stashList(dir)).toBe("");
  });

  it("preserves closed-task archived orphan when stash still differs", async () => {
    const sha = createAutostash(dir, "FN-1002", "archived-content\n");

    await sweepAutostashOrphans(dir, "FN-MERGE", makeStore({ "FN-1002": "archived" }));

    expect(stashList(dir)).toContain(sha);
  });

  it("drops open-task orphan with empty path diff via existing subsumed path", async () => {
    createAutostash(dir, "FN-1003", "open-matched\n");
    writeFileSync(join(dir, "file.txt"), "open-matched\n");
    git(dir, "git add file.txt");
    git(dir, 'git commit -m "match open stash"');

    await sweepAutostashOrphans(dir, "FN-MERGE", makeStore({ "FN-1003": "in-progress" }));

    expect(stashList(dir)).toBe("");
  });

  it("preserves open-task orphan with real diff", async () => {
    const sha = createAutostash(dir, "FN-1004", "open-live\n");

    await sweepAutostashOrphans(dir, "FN-MERGE", makeStore({ "FN-1004": "in-progress" }));

    expect(stashList(dir)).toContain(sha);
  });

  it("preserves orphan when store.getTask throws", async () => {
    const sha = createAutostash(dir, "FN-1005", "throw-case\n");

    await sweepAutostashOrphans(dir, "FN-MERGE", makeStore({}, { throwOnGetTask: true }));

    expect(stashList(dir)).toContain(sha);
  });
});
