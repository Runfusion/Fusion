import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Settings, Task, TaskStore } from "@fusion/core";
import { MAX_AUTO_MERGE_RETRIES, SelfHealingManager } from "../../self-healing.js";

const NOW = "2026-05-23T12:00:00.000Z";
const DEADLOCK_RECOVERY_COOLDOWN_MS = 15 * 60_000; // keep in sync with self-healing.ts:~308

type Store = TaskStore & {
  moveTask: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  logEntry: ReturnType<typeof vi.fn>;
};

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    status: null,
    paused: false,
    blockedBy: null,
    overlapBlockedBy: null,
    dependencies: [],
    log: [],
    steps: [],
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(seed: Task[]): { store: Store; tasks: Map<string, Task> } {
  const tasks = new Map(seed.map((task) => [task.id, { ...task }]));

  const store = {
    getSettings: vi.fn(async () => ({
      globalPause: false,
      enginePaused: false,
      autoMerge: true,
      taskStuckTimeoutMs: 60_000,
      inReviewStallDeadlockThreshold: 1,
      staleMergingStatusMinAgeMs: 60_000,
      staleMergingFanoutMinAgeMs: 60_000,
      inReviewStalledThresholdMs: 60_000,
      stalePausedReviewThresholdMs: 60_000,
      engineActiveSinceMs: undefined,
      engineActivationGraceMs: 0,
    }) satisfies Partial<Settings>),
    listTasks: vi.fn(async (opts?: { column?: Task["column"]; includeDeleted?: boolean }) => {
      return [...tasks.values()]
        .filter((task) => (opts?.column ? task.column === opts.column : true))
        .filter((task) => (opts?.includeDeleted ? true : !task.deletedAt))
        .map((task) => ({ ...task }));
    }),
    getTask: vi.fn(async (id: string) => {
      const task = tasks.get(id);
      return task ? { ...task } : undefined;
    }),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`Task ${id} missing`);
      tasks.set(id, { ...current, ...patch });
      return { ...tasks.get(id)! };
    }),
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`Task ${id} missing`);
      const moved = { ...current, column, updatedAt: new Date().toISOString() } as Task;
      tasks.set(id, moved);
      return moved;
    }),
    logEntry: vi.fn(async (id: string, action: string) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`Task ${id} missing`);
      const next = {
        ...current,
        log: [...(current.log ?? []), { timestamp: new Date().toISOString(), action }],
      } as Task;
      tasks.set(id, next);
    }),
    recordRunAuditEvent: vi.fn(async () => undefined),
  } as unknown as Store;

  return { store, tasks };
}

async function runPolicyCycle(manager: SelfHealingManager): Promise<void> {
  await manager.recoverAlreadyMergedReviewTasks();
  await manager.recoverStuckMergeDeadlocks();
  await manager.clearStaleBlockedBy();
  await manager.surfaceInReviewStalls();
}

describe("FN-5536 retry-exhausted in-review policy convergence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("live signature converges to a stable disposition without stranding dependents", async () => {
    const blocker = makeTask("FN-BLOCK", {
      column: "in-review",
      status: "failed",
      mergeRetries: MAX_AUTO_MERGE_RETRIES,
      paused: false,
      mergeDetails: { mergeConfirmed: false } as Task["mergeDetails"],
      worktree: "/tmp/wt-live",
      updatedAt: "2026-05-21T00:00:00.000Z",
      columnMovedAt: new Date(Date.parse(NOW) - DEADLOCK_RECOVERY_COOLDOWN_MS - 1).toISOString(),
    });
    const depBlocked = makeTask("FN-DEP-BLOCKED", { column: "todo", blockedBy: "FN-BLOCK", status: "queued" });
    const depWithDependency = makeTask("FN-DEP-DEP", {
      column: "todo",
      blockedBy: "FN-BLOCK",
      status: "queued",
      dependencies: ["FN-BLOCK"],
    });
    const { store, tasks } = createStore([blocker, depBlocked, depWithDependency]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.spyOn(manager as any, "findAlreadyMergedTaskCommit").mockResolvedValue(null);
    vi.spyOn(manager as any, "findLandedTaskCommit").mockResolvedValue(null);
    vi.spyOn(manager as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({ ok: true });

    await runPolicyCycle(manager);

    const blockerAfter = tasks.get("FN-BLOCK")!;
    const dep1 = tasks.get("FN-DEP-BLOCKED")!;
    const dep2 = tasks.get("FN-DEP-DEP")!;
    const noStrandingViolation = blockerAfter.paused === false && dep1.blockedBy === "FN-BLOCK" && dep2.blockedBy === "FN-BLOCK";

    expect(noStrandingViolation).toBe(false);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-BLOCK",
      "merge-deadlock-detected: requires manual intervention — verified content not on main",
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-DEP-BLOCKED",
      expect.stringContaining("Auto-recovered (FN-5488): cleared stale blockedBy"),
    );
  });

  it("already-landed live signature is recovered to done and unblocks dependents", async () => {
    const blocker = makeTask("FN-LANDED", {
      column: "in-review",
      status: "failed",
      mergeRetries: MAX_AUTO_MERGE_RETRIES,
      paused: false,
      mergeDetails: { mergeConfirmed: false } as Task["mergeDetails"],
      worktree: "/tmp/wt-landed",
      baseBranch: "main",
      updatedAt: "2026-05-21T00:00:00.000Z",
    });
    const dependent = makeTask("FN-DEP", {
      column: "todo",
      blockedBy: "FN-LANDED",
      status: "queued",
      dependencies: ["FN-LANDED"],
    });

    const { store, tasks } = createStore([blocker, dependent]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.spyOn(manager as any, "findAlreadyMergedTaskCommit").mockResolvedValue({
      sha: "abc1234567890def",
      strategy: "task-id-trailer",
    });
    vi.spyOn(manager as any, "findLandedTaskCommit").mockResolvedValue(null);
    vi.spyOn(manager as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({ ok: true });
    vi.spyOn(manager as any, "reconcileCompletedTask").mockResolvedValue(undefined);

    await runPolicyCycle(manager);

    expect(tasks.get("FN-LANDED")?.column).toBe("done");
    expect(tasks.get("FN-LANDED")?.mergeDetails?.mergeConfirmed).toBe(true);
    expect(tasks.get("FN-DEP")?.blockedBy).toBeNull();
  });

  it("soft-deleted signature is a no-op (negative control)", async () => {
    const deleted = makeTask("FN-DELETED", {
      column: "in-review",
      status: "failed",
      mergeRetries: MAX_AUTO_MERGE_RETRIES,
      paused: false,
      mergeDetails: { mergeConfirmed: false } as Task["mergeDetails"],
      worktree: "/tmp/wt-deleted",
      deletedAt: "2026-05-20T05:50:51.015Z",
      updatedAt: "2026-05-21T00:00:00.000Z",
    });
    const { store } = createStore([deleted]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    // Hand-off to FN-5528: defensive deletedAt guards in sweeps will harden this when listTasks is bypassed.
    vi.spyOn(manager as any, "findAlreadyMergedTaskCommit").mockResolvedValue(null);
    vi.spyOn(manager as any, "findLandedTaskCommit").mockResolvedValue(null);
    vi.spyOn(manager as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({ ok: true });

    await runPolicyCycle(manager);

    expect(store.updateTask).not.toHaveBeenCalledWith("FN-DELETED", expect.anything());
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-DELETED", expect.anything());
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-DELETED", expect.anything());
  });
});
