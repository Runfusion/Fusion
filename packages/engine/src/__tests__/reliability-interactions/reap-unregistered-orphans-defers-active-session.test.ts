import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, TaskStore } from "@fusion/core";
import { activeSessionRegistry } from "../../active-session-registry.js";
import { SelfHealingManager } from "../../self-healing.js";

function sh(command: string, cwd: string): string {
  return String(execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }) ?? "");
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "fn-5065-"));
  sh("git init", root);
  sh("git config user.email 'test@example.com'", root);
  sh("git config user.name 'Test User'", root);
  writeFileSync(join(root, "README.md"), "base\n", "utf-8");
  sh("git add README.md", root);
  sh("git commit -m 'init'", root);
  sh("git branch -M main", root);
  return root;
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
    const orphanPath = join(repo, ".worktrees", "fn-5065-active");
    mkdirSync(orphanPath, { recursive: true });
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
    const orphanPath = join(repo, ".worktrees", "fn-5065-control");
    mkdirSync(orphanPath, { recursive: true });
    writeFileSync(join(orphanPath, "stale.txt"), "stale\n", "utf-8");

    const manager = new SelfHealingManager(makeStore() as any, { rootDir: repo } as any);
    const cleaned = await (manager as any).reapUnregisteredOrphans();

    expect(cleaned).toBe(1);
    expect(existsSync(orphanPath)).toBe(false);
    manager.stop();
  });
});
