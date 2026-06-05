import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logger } = vi.hoisted(() => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../logger.js", () => ({ createLogger: vi.fn(() => logger) }));

import { TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();
}

describe("FN-5219 reliability interactions: in-progress limbo recovery", () => {
  let rootDir = "";
  let store: TaskStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00.000Z"));
    rootDir = mkdtempSync(join(tmpdir(), "fn-5219-reliability-"));
    git(rootDir, "init -b main");
    git(rootDir, "config user.name 'Fusion'");
    git(rootDir, "config user.email 'hi@runfusion.ai'");
    writeFileSync(join(rootDir, "README.md"), "root\n");
    git(rootDir, "add README.md");
    git(rootDir, "commit -m 'init'");
    mkdirSync(join(rootDir, ".worktrees"), { recursive: true });
    store = new TaskStore(rootDir, undefined, { inMemoryDb: false });
  });

  afterEach(() => {
    try { store?.close(); } catch {}
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function createInProgressTask(title: string) {
    const task = await store.createTask({ title, description: title });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    return task.id;
  }

  it("FN-5149: reset twice → stranded in-progress with missing worktree → recovered to todo", async () => {
    const mockStore = Object.assign(new EventEmitter(), {
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false }),
      listTasks: vi.fn()
        .mockResolvedValueOnce([
          {
            id: "FN-5149",
            column: "in-progress",
            paused: false,
            branch: null,
            worktree: join(rootDir, ".worktrees", "fn-5149-missing"),
            updatedAt: "2026-05-20T12:00:00.000Z",
            steps: [{ status: "pending" }],
            log: [],
          },
        ])
        .mockResolvedValueOnce([]),
      updateTask: vi.fn().mockResolvedValue({}),
      logEntry: vi.fn().mockResolvedValue(undefined),
      moveTask: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
      getRootDir: vi.fn().mockReturnValue(rootDir),
    }) as unknown as TaskStore;
    vi.setSystemTime(new Date("2026-05-20T12:02:00.000Z"));

    const manager = new SelfHealingManager(mockStore, {
      rootDir,
      getExecutingTaskIds: () => new Set<string>(),
    });

    const first = await manager.recoverInProgressLimbo();
    const second = await manager.recoverOrphanedExecutions();

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(mockStore.moveTask).toHaveBeenCalledWith("FN-5149", "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
    expect(mockStore.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-in-progress-limbo",
      target: "FN-5149",
    }));
  });

  it("reconcile-task-worktree-metadata runs first so a live rebindable worktree wins", async () => {
    const id = await createInProgressTask("metadata rebind wins");
    const liveWorktree = join(rootDir, ".worktrees", `${id.toLowerCase()}-live`);
    const branch = `fusion/${id.toLowerCase()}`;
    git(rootDir, `worktree add -b ${branch} ${liveWorktree}`);
    writeFileSync(join(liveWorktree, `${id}.txt`), `${id}\n`);
    git(liveWorktree, `add ${id}.txt`);
    git(liveWorktree, `commit -m 'task work'`);
    git(rootDir, "checkout main");

    await store.updateTask(id, {
      branch: null,
      worktree: join(rootDir, ".worktrees", `${id.toLowerCase()}-missing`),
      steps: [{ name: "step", status: "pending" }],
    });
    vi.setSystemTime(new Date("2026-05-20T12:02:00.000Z"));

    const manager = new SelfHealingManager(store, {
      rootDir,
      getExecutingTaskIds: () => new Set<string>(),
    });

    const repaired = await manager.reconcileTaskWorktreeMetadata({ includeTaskIds: new Set([id]) });
    const recovered = await manager.recoverInProgressLimbo();
    const updated = await store.getTask(id);

    expect(repaired).toBe(1);
    expect(recovered).toBe(0);
    expect(updated?.column).toBe("in-progress");
    expect(updated?.branch).toBe(branch);
    expect(updated?.worktree?.endsWith(`${id.toLowerCase()}-live`)).toBe(true);
  });

  it("keeps in-review missing-worktree failures on the review-specific recovery path", async () => {
    const id = await createInProgressTask("review failure disjoint");
    await store.moveTask(id, "in-review");
    await store.updateSettings({ autoMerge: true } as any);
    await store.updateTask(id, {
      status: "failed",
      error: `Refusing to start coding agent in missing worktree: ${join(rootDir, ".worktrees", "missing-review")}`,
      branch: `fusion/${id.toLowerCase()}`,
      worktree: join(rootDir, ".worktrees", "missing-review-stale"),
      steps: [{ name: "step", status: "done" }, { name: "next", status: "pending" }],
    });
    await store.updateTask(id, {
      updatedAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
      columnMovedAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
    } as any);

    const manager = new SelfHealingManager(store, {
      rootDir,
      getExecutingTaskIds: () => new Set<string>(),
    });

    const limboRecovered = await manager.recoverInProgressLimbo();
    const reviewRecovered = await manager.recoverMissingWorktreeReviewFailures();
    const updated = await store.getTask(id);

    expect(limboRecovered).toBe(0);
    expect(reviewRecovered).toBe(0);
    expect(updated?.column).toBe("in-review");
  });

  it("skips limbo recovery while the executor still claims the task id", async () => {
    const id = await createInProgressTask("executor claim wins");
    await store.updateTask(id, {
      branch: null,
      worktree: join(rootDir, ".worktrees", `${id.toLowerCase()}-missing`),
      steps: [{ name: "step", status: "pending" }],
    });
    vi.setSystemTime(new Date("2026-05-20T12:02:00.000Z"));

    const manager = new SelfHealingManager(store, {
      rootDir,
      getExecutingTaskIds: () => new Set<string>([id]),
    });

    const recovered = await manager.recoverInProgressLimbo();
    const updated = await store.getTask(id);

    expect(recovered).toBe(0);
    expect(updated?.column).toBe("in-progress");
    expect(updated?.worktree).toContain("missing");
  });
});
