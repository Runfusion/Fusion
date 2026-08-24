import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, TaskStore } from "@fusion/core";
import { activeSessionRegistry } from "../../agents/active-session-registry.js";
import { SelfHealingManager } from "../../self-healing.js";

function sh(command: string, cwd: string): string {
  return String(execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }) ?? "");
}

function makeRepo(): string {
  // Canonicalize: on macOS `tmpdir()` is a symlink (/var -> /private/var) and Git writes the
  // resolved path into a linked worktree's `.git` gitdir pointer. An uncanonicalized rootDir makes
  // the ownership proof compare two spellings of the same directory.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fn-5065-")));
  sh("git init", root);
  sh("git config user.email 'test@example.com'", root);
  sh("git config user.name 'Test User'", root);
  writeFileSync(join(root, "README.md"), "base\n", "utf-8");
  sh("git add README.md", root);
  sh("git commit -m 'init'", root);
  sh("git branch -M main", root);
  return root;
}

/*
FNXC:WorkspaceWorktree 2026-08-23-18:38:
`isReclaimableWorktreeCandidate` now requires Git to PROVE a candidate belongs to this project
before any destructive sweep touches it (a shared configured worktree root can hold another
project's checkouts). A bare `mkdir` under `.worktrees/` is therefore no longer reapable by
design, so the fixture builds a real linked worktree and then deletes only its ADMIN entry —
which is exactly what an unregistered orphan is: a proven-ours checkout that `git worktree list`
has forgotten. Both cases use it so the active-session deferral is proven against a path the
sweep would otherwise really remove, rather than one it declines for an unrelated reason.
*/
function makeUnregisteredOrphan(repo: string, name: string): string {
  const orphanPath = join(repo, ".worktrees", name);
  sh(`git worktree add -b ${name} ${JSON.stringify(orphanPath)} main`, repo);
  // Drop the admin registration only; the worktree's `.git` gitdir pointer stays, so Git can
  // still prove ownership while `git worktree list` no longer reports the path.
  rmSync(join(repo, ".git", "worktrees", name), { recursive: true, force: true });
  return orphanPath;
}

function makeStore(): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    baseBranch: "main",
    mergeStrategy: "direct",
    autoRecovery: { mode: "deterministic-only", maxRetries: 3 },
  } as unknown as Settings;

  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async () => []),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
  }) as unknown as TaskStore & EventEmitter;
}

describe("FN-4811 / FN-5065: reapUnregisteredOrphans defers active-session paths", () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    activeSessionRegistry.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    activeSessionRegistry.clear();
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FN-5065: does not remove unregistered orphan while path is active in FN-4811 registry", async () => {
    const repo = makeRepo();
    tempRoots.push(repo);
    const orphanPath = makeUnregisteredOrphan(repo, "fn-5065-active");
    writeFileSync(join(orphanPath, "progress.txt"), "in-flight\n", "utf-8");
    activeSessionRegistry.registerPath(orphanPath, { taskId: "FN-5065", kind: "executor", ownerKey: "FN-5065" });

    const manager = new SelfHealingManager(makeStore() as any, { rootDir: repo } as any);
    const cleaned = await (manager as any).reapUnregisteredOrphans();

    expect(cleaned).toBe(0);
    expect(existsSync(orphanPath)).toBe(true);
    manager.stop();
  });

  it("FN-5065 control: removes unregistered orphan when no FN-4811 active session is registered", async () => {
    const repo = makeRepo();
    tempRoots.push(repo);
    const orphanPath = makeUnregisteredOrphan(repo, "fn-5065-control");
    writeFileSync(join(orphanPath, "stale.txt"), "stale\n", "utf-8");

    const manager = new SelfHealingManager(makeStore() as any, { rootDir: repo } as any);
    const cleaned = await (manager as any).reapUnregisteredOrphans();

    expect(cleaned).toBe(1);
    expect(existsSync(orphanPath)).toBe(false);
    manager.stop();
  });
});
