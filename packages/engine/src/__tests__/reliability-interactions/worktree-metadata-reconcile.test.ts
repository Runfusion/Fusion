import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import type { Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";
import * as worktreePoolModule from "../../worktree/worktree-pool.js";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function makeStore(tasks: Task[]): TaskStore & EventEmitter {
  const map = new Map(tasks.map((t) => [t.id, t]));
  return Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async () => [...map.values()]),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      map.set(id, { ...(map.get(id) as Task), ...patch });
      return map.get(id);
    }),
    getTask: vi.fn(async (id: string) => map.get(id)),
    recordRunAuditEvent: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
}

describe("reliability interactions: worktree metadata reconcile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("defers while task is in executingTaskIds (recoverOrphaned/resume interaction)", async () => {
    const store = makeStore([task("FN-1", { column: "in-review", worktree: "/missing", branch: undefined })]);
    vi.spyOn(worktreePoolModule, "getRegisteredWorktreeBranchMap").mockResolvedValue(new Map([["fusion/fn-1", "/live"]]));

    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      getExecutingTaskIds: () => new Set(["FN-1"]),
    });

    const repaired = await manager.reconcileTaskWorktreeMetadata();
    expect(repaired).toBe(0);
    expect((store as any).updateTask).not.toHaveBeenCalled();
  });

  it("rebinds exactly once after deferred pass (acquireTaskWorktree interaction)", async () => {
    const store = makeStore([task("FN-2", { column: "todo", worktree: "/missing", branch: undefined })]);
    vi.spyOn(worktreePoolModule, "getRegisteredWorktreeBranchMap").mockResolvedValue(new Map([["fusion/fn-2", "/live"]]));

    let executing = true;
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      getExecutingTaskIds: () => (executing ? new Set(["FN-2"]) : new Set<string>()),
    });

    expect(await manager.reconcileTaskWorktreeMetadata()).toBe(0);
    executing = false;
    expect(await manager.reconcileTaskWorktreeMetadata()).toBe(1);
    expect((store as any).updateTask).toHaveBeenCalledTimes(1);
  });

  it("runs reconcile before reclaim-stale-active-branches in maintenance ordering", () => {
    const selfHealingPath = fileURLToPath(new URL("../../self-healing.ts", import.meta.url));
    const source = readFileSync(selfHealingPath, "utf8");
    const maintenanceSlice = source.slice(
      source.indexOf("const batch2Fns:"),
      source.indexOf("for (const fn of batch2Fns)"),
    );

    expect(maintenanceSlice.indexOf('"reconcile-task-worktree-metadata"')).toBeLessThan(
      maintenanceSlice.indexOf('"reclaim-stale-active-branches"'),
    );
  });

  it("skips done tasks during periodic reconcile (completion fan-out owns done lifecycle)", async () => {
    const store = makeStore([task("FN-3", { column: "done", worktree: "/missing", branch: undefined })]);
    vi.spyOn(worktreePoolModule, "getRegisteredWorktreeBranchMap").mockResolvedValue(new Map([["fusion/fn-3", "/live"]]));

    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const repaired = await manager.reconcileTaskWorktreeMetadata();

    expect(repaired).toBe(0);
    expect((store as any).updateTask).not.toHaveBeenCalled();
  });
});
