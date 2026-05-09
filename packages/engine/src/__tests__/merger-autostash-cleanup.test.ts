import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { TaskStore } from "@fusion/core";
import { __test__ } from "../merger.js";

const { sweepAutostashOrphans, parseAutostashTaskId } = __test__;

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

describe("sweepAutostashOrphans", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fn-autostash-"));
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
