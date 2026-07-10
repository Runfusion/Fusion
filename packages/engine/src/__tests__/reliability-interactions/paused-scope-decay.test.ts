import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

type AuditEvent = { mutationType: string; taskId?: string; metadata?: Record<string, unknown> };

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    log: [],
    ...overrides,
  } as Task;
}

function makeStore(tasks: Task[], settings: Partial<Settings> = {}) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const audits: AuditEvent[] = [];
  const emitter = new EventEmitter();
  const store = Object.assign(emitter, {
    getSettings: vi.fn(async () => ({
      globalPause: false,
      enginePaused: false,
      pausedScopeDecayMs: 30 * 60_000,
      ...settings,
    })),
    listTasks: vi.fn(async ({ column, includeArchived }: any = {}) =>
      [...byId.values()].filter((task) => {
        if (column && task.column !== column) return false;
        if (includeArchived === false && task.column === "archived") return false;
        return true;
      }),
    ),
    moveTask: vi.fn(async (id: string, column: Task["column"], _opts?: any) => {
      byId.set(id, { ...byId.get(id)!, column, paused: false, pausedReason: undefined, blockedBy: undefined, overlapBlockedBy: undefined } as Task);
      return byId.get(id)!;
    }),
    updateTask: vi.fn(async (id: string, updates: Partial<Task>) => {
      byId.set(id, { ...byId.get(id)!, ...updates } as Task);
      return byId.get(id)!;
    }),
    getTask: vi.fn(async (id: string) => byId.get(id)),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async (event: any) => {
      audits.push({ mutationType: event.mutationType, taskId: event.taskId, metadata: event.metadata });
    }),
  });

  return { store: store as unknown as TaskStore & EventEmitter, byId, audits };
}

describe("reliability interactions: paused scope decay", () => {
  it("rebounds stale paused in-progress holder with followers and emits audit", async () => {
    const now = Date.now();
    const holder = makeTask("FN-1", {
      column: "in-progress",
      paused: true,
      pausedReason: "waiting",
      executionStartedAt: new Date(now - 31 * 60_000).toISOString(),
      columnMovedAt: new Date(now - 31 * 60_000).toISOString(),
      currentStep: 2,
      steps: [{ id: "s1", title: "x", status: "done" } as any],
      worktree: "/tmp/wt",
    });
    const follower = makeTask("FN-2", { column: "todo", blockedBy: "FN-1", status: "queued" });
    const { store, byId, audits } = makeStore([holder, follower]);
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set() });

    const count = await manager.autoReboundPausedScopeDecay();
    expect(count).toBe(1);
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "todo", expect.objectContaining({
      preserveProgress: true,
      preserveWorktree: true,
      preserveResumeState: true,
      moveSource: "engine",
    }));
    expect((store.moveTask as any).mock.calls[0][2].moveSource).toBe("engine");
    expect((store.moveTask as any).mock.calls[0][2].moveSource).not.toBe("user");
    expect(byId.get("FN-1")?.currentStep).toBe(2);
    expect(byId.get("FN-1")?.worktree).toBe("/tmp/wt");
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", expect.stringContaining("Auto-rebounded (FN-4890)"));
    expect(audits.some((event) => event.mutationType === "task:auto-rebound-paused-scope-decay")).toBe(true);

    expect(byId.get("FN-1")?.column).toBe("todo");
    expect(byId.get("FN-2")?.blockedBy).toBe("FN-1");
  });

  it("supports ignoreAgeGate override", async () => {
    const now = Date.now();
    const holder = makeTask("FN-3", {
      column: "in-progress",
      paused: true,
      executionStartedAt: new Date(now - 61_000).toISOString(),
      columnMovedAt: new Date(now - 1_000).toISOString(),
    });
    const follower = makeTask("FN-4", { column: "todo", blockedBy: "FN-3" });
    const { store } = makeStore([holder, follower], { pausedScopeDecayMs: 60_000 });
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set() });

    expect(await manager.autoReboundPausedScopeDecay()).toBe(0);
    expect(await manager.autoReboundPausedScopeDecay({ ignoreAgeGate: true })).toBe(1);
  });

  it("no-op when there are no followers", async () => {
    const now = Date.now();
    const holder = makeTask("FN-5", { column: "in-progress", paused: true, columnMovedAt: new Date(now - 31 * 60_000).toISOString() });
    const unrelated = makeTask("FN-6", { column: "todo", blockedBy: "FN-X" });
    const { store } = makeStore([holder, unrelated]);
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set() });
    expect(await manager.autoReboundPausedScopeDecay()).toBe(0);
  });

  it.each([
    { name: "threshold disabled", holder: { paused: true }, settings: { pausedScopeDecayMs: 0 } },
    { name: "excluded paused reason", holder: { paused: true, pausedReason: "branch-conflict-unrecoverable" as const } },
    { name: "not paused", holder: { paused: false } },
    { name: "age below threshold", holder: { paused: true }, settings: { pausedScopeDecayMs: 60_000 }, ageMs: 500 },
    // FN-7736: the canonical approval-hold reason must be excluded too.
    { name: "approval-held (canonical reason)", holder: { paused: true, pausedReason: "awaiting-approval" as const } },
  ])("no-op: $name", async ({ holder, settings, ageMs }) => {
    const now = Date.now();
    const effectiveAgeMs = ageMs ?? 31 * 60_000;
    const pausedHolder = makeTask("FN-8", {
      column: "in-progress",
      columnMovedAt: new Date(now - effectiveAgeMs).toISOString(),
      ...holder,
    });
    const follower = makeTask("FN-9", { column: "todo", blockedBy: "FN-8" });
    const { store } = makeStore([pausedHolder, follower], settings);
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set() });
    expect(await manager.autoReboundPausedScopeDecay()).toBe(0);
  });

  /*
   * FNXC:ApprovalHold 2026-07-09-00:20:
   * FN-7736 symptom-verification regression. Reproduces the exact original
   * failure shape (approval-held in-progress task, no pausedReason, follower
   * present, decay threshold elapsed) alongside a same-shaped control task
   * that IS paused but for an unrelated (non-approval) reason, proving the
   * assertion actually exercises the exclusion mechanism rather than a
   * vacuously-true "nothing ever reboundeds" check.
   */
  it("symptom verification: leaves an approval-held task in place while still rebounding a control paused task", async () => {
    const now = Date.now();
    const approvalHeld = makeTask("FN-APPROVAL", {
      column: "in-progress",
      paused: true,
      pausedReason: "awaiting-approval",
      executionStartedAt: new Date(now - 31 * 60_000).toISOString(),
      columnMovedAt: new Date(now - 31 * 60_000).toISOString(),
    });
    const approvalFollower = makeTask("FN-APPROVAL-FOLLOWER", { column: "todo", blockedBy: "FN-APPROVAL" });
    const controlPaused = makeTask("FN-CONTROL", {
      column: "in-progress",
      paused: true,
      pausedReason: "some-other-reason",
      executionStartedAt: new Date(now - 31 * 60_000).toISOString(),
      columnMovedAt: new Date(now - 31 * 60_000).toISOString(),
    });
    const controlFollower = makeTask("FN-CONTROL-FOLLOWER", { column: "todo", blockedBy: "FN-CONTROL" });
    const { store, byId } = makeStore([approvalHeld, approvalFollower, controlPaused, controlFollower]);
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set() });

    const count = await manager.autoReboundPausedScopeDecay();

    // Only the control task is rebounded -- the approval-held task is untouched.
    expect(count).toBe(1);
    expect(store.moveTask).toHaveBeenCalledWith("FN-CONTROL", "todo", expect.anything());
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-APPROVAL", "todo", expect.anything());
    expect(byId.get("FN-APPROVAL")?.column).toBe("in-progress");
    expect(byId.get("FN-APPROVAL")?.paused).toBe(true);
    expect(byId.get("FN-APPROVAL")?.pausedReason).toBe("awaiting-approval");
    expect(byId.get("FN-CONTROL")?.column).toBe("todo");
  });
});
