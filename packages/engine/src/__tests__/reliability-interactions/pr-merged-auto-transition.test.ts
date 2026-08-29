import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import * as worktreePool from "../../worktree/worktree-pool.js";
import { activeSessionRegistry } from "../../agents/active-session-registry.js";
import { SelfHealingManager } from "../../self-healing.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-4992-M",
    title: "t",
    description: "d",
    column: "in-review",
    branch: "fusion/fn-4992-m",
    worktree: "/tmp/test/.worktrees/fn-4992-m",
    paused: true,
    userPaused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    mergeDetails: { mergeConfirmed: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function store(primary: Task, extras: Task[] = []): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const map = new Map([primary, ...extras].map((t) => [t.id, t]));
  const settings = { globalPause: false, enginePaused: false } as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    getTask: vi.fn(async (id: string) => map.get(id) ?? null),
    listTasks: vi.fn(async ({ column }: { column?: Task["column"] } = {}) => {
      const all = [...map.values()];
      return column ? all.filter((t) => t.column === column) : all;
    }),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const next = { ...(map.get(id) as Task), ...patch } as Task;
      map.set(id, next);
      return next;
    }),
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const current = map.get(id) as Task;
      const next = { ...current, column } as Task;
      map.set(id, next);
      return next;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    recordRunAuditEvent: vi.fn(async () => undefined),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    getRootDir: vi.fn(() => "/tmp/test"),
  }) as unknown as TaskStore & EventEmitter;
}

function isInvalidDoneTransitionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Invalid transition:") && /['"]done['"]/.test(message);
}

async function runMergeConfirmedFinalizePass(s: TaskStore & EventEmitter, taskId: string): Promise<void> {
  const current = await s.getTask(taskId);
  if (!current || current.column !== "in-review") return;
  if (!current.mergeDetails?.mergeConfirmed) return;

  await s.updateTask(taskId, { paused: false, status: null, error: null });
  try {
    await s.moveTask(taskId, "done");
  } catch (error) {
    if (isInvalidDoneTransitionError(error)) {
      const latest = await s.getTask(taskId).catch(() => null);
      if (latest && latest.column !== "in-review") {
        await s.logEntry(
          taskId,
          `Merge confirmed finalize skipped: task moved to '${latest.column}' before in-review → done transition`,
        );
        return;
      }
    }
    throw error;
  }
}

describe("reliability interaction (FN-4766/FN-4762): PR merged auto-transition", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    activeSessionRegistry.clear();
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
  });

  it("transitions mergeConfirmed in-review task to done exactly once and keeps second pass as no-op", async () => {
    const merged = task();
    const dependent = task({ id: "FN-DEP", column: "todo", blockedBy: merged.id, mergeDetails: undefined });
    const s = store(merged, [dependent]);

    await runMergeConfirmedFinalizePass(s, merged.id);

    const manager = new SelfHealingManager(s as any, { rootDir: "/tmp/test" } as any);
    await expect(manager.reconcileCompletedTask(merged.id)).resolves.toMatchObject({ blockedByCleared: 1 });

    expect((await (s as any).getTask(merged.id)).column).toBe("done");
    expect((s as any).moveTask).toHaveBeenCalledTimes(1);
    expect((await (s as any).getTask("FN-DEP")).blockedBy).toBeNull();

    await runMergeConfirmedFinalizePass(s, merged.id);
    expect((s as any).moveTask).toHaveBeenCalledTimes(1);
    expect((await (s as any).getTask(merged.id)).status).not.toBe("merging-fix");
    expect((await (s as any).getTask(merged.id)).column).toBe("done");
  });

  it("recovers invalid done transition when latest task already moved out of in-review", async () => {
    const merged = task();
    const s = store(merged);
    const moveError = new Error("Invalid transition: 'in-review' → 'done'");
    (s as any).moveTask = vi.fn(async (_id: string, _column: Task["column"]) => {
      await (s as any).updateTask(merged.id, { column: "todo" });
      throw moveError;
    });

    await expect(runMergeConfirmedFinalizePass(s, merged.id)).resolves.toBeUndefined();

    expect((s as any).moveTask).toHaveBeenCalledTimes(1);
    expect((s as any).logEntry).toHaveBeenCalledTimes(1);
    expect((s as any).updateTask).toHaveBeenCalledWith(merged.id, { paused: false, status: null, error: null });
  });
});
