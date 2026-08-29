import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

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
    executionStartedAt: new Date(Date.now() - 61_000).toISOString(),
    log: [],
    ...overrides,
  } as Task;
}

function makeStore(tasks: Task[], settings: Partial<Settings> = {}) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const audits: string[] = [];
  const emitter = new EventEmitter();
  const store = Object.assign(emitter, {
    getSettings: vi.fn(async () => ({
      globalPause: false,
      enginePaused: false,
      pausedScopeDecayMs: 60_000,
      boardStallSweepWindowMs: 60_000,
      boardStallBlockedGrowthThreshold: 1,
      ...settings,
    })),
    listTasks: vi.fn(async ({ column, includeArchived }: any = {}) =>
      [...byId.values()].filter((task) => {
        if (column && task.column !== column) return false;
        if (includeArchived === false && task.column === "archived") return false;
        return true;
      })),
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const prev = byId.get(id)!;
      const next = { ...prev, column, paused: false, blockedBy: undefined, overlapBlockedBy: undefined } as Task;
      byId.set(id, next);
      emitter.emit("task:moved", { task: next, from: prev.column, to: column, source: "engine" });
      return next;
    }),
    getTask: vi.fn(async (id: string) => byId.get(id)),
    archiveTaskAndCleanup: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async (event: any) => audits.push(event.mutationType)),
  });
  return { store: store as unknown as TaskStore & EventEmitter, byId, audits };
}

describe("reliability interactions: board stall auto-recovery", () => {
  it("emits broken then unrecovered events and notifies once", async () => {
    const holder = makeTask("FN-1", { column: "in-progress", paused: true, pausedReason: "waiting" });
    const { store, byId, audits } = makeStore([holder]);
    const notify = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, {
      rootDir: process.cwd(),
      getExecutingTaskIds: () => new Set(),
      ntfyNotifier: { notifyBoardStallUnrecovered: notify },
    });
    manager.start();

    await manager.runBoardStallAutoRecoverySweep();
    byId.set("FN-2", makeTask("FN-2", { column: "todo", blockedBy: "FN-1" }));

    const first = await manager.runBoardStallAutoRecoverySweep();
    expect(first.recovered).toBe(1);
    expect(audits).toContain("task:auto-board-stall-broken");
    expect(notify).not.toHaveBeenCalled();

    (manager as any).maintenanceTickCounter++;
    const second = await manager.runBoardStallAutoRecoverySweep();
    expect(second.unrecovered).toBe(true);
    expect(audits).toContain("task:auto-board-stall-unrecovered");
    expect(notify).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("skips unrecovered notification when progress resumes", async () => {
    const holder = makeTask("FN-10", { column: "in-progress", paused: true, pausedReason: "waiting" });
    const { store, byId } = makeStore([holder]);
    const notify = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set(), ntfyNotifier: { notifyBoardStallUnrecovered: notify } });
    manager.start();

    await manager.runBoardStallAutoRecoverySweep();
    byId.set("FN-11", makeTask("FN-11", { column: "todo", blockedBy: "FN-10" }));
    await manager.runBoardStallAutoRecoverySweep();
    (manager as any).boardStallWindow.transitionsOutOfInProgressInWindow = 1;
    (manager as any).maintenanceTickCounter++;
    const verification = await manager.runBoardStallAutoRecoverySweep();
    expect(verification.unrecovered).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    manager.stop();
  });

  it("enforces cooldown for repeated unrecovered alerts", async () => {
    const holder = makeTask("FN-20", { column: "in-progress", paused: true, pausedReason: "waiting" });
    const { store, byId } = makeStore([holder]);
    const notify = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set(), ntfyNotifier: { notifyBoardStallUnrecovered: notify } });
    manager.start();

    await manager.runBoardStallAutoRecoverySweep();
    byId.set("FN-21", makeTask("FN-21", { column: "todo", blockedBy: "FN-20" }));
    await manager.runBoardStallAutoRecoverySweep();
    (manager as any).maintenanceTickCounter++;
    await manager.runBoardStallAutoRecoverySweep();

    (manager as any).boardStallWindow.pendingVerification = { holderIds: ["FN-20"], followerCount: 1, startedAt: Date.now(), tick: 0 };
    (manager as any).maintenanceTickCounter++;
    await manager.runBoardStallAutoRecoverySweep();

    expect(notify).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("skips unrecovered notification when progress resumes", async () => {
    const holder = makeTask("FN-10", { column: "in-progress", paused: true, pausedReason: "waiting" });
    const { store, byId } = makeStore([holder]);
    const notify = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set(), ntfyNotifier: { notifyBoardStallUnrecovered: notify } });
    manager.start();

    await manager.runBoardStallAutoRecoverySweep();
    byId.set("FN-11", makeTask("FN-11", { column: "todo", blockedBy: "FN-10" }));
    await manager.runBoardStallAutoRecoverySweep();
    (manager as any).boardStallWindow.transitionsOutOfInProgressInWindow = 1;
    (manager as any).maintenanceTickCounter++;
    const verification = await manager.runBoardStallAutoRecoverySweep();
    expect(verification.unrecovered).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    manager.stop();
  });

  it("enforces cooldown for repeated unrecovered alerts", async () => {
    const holder = makeTask("FN-20", { column: "in-progress", paused: true, pausedReason: "waiting" });
    const { store, byId } = makeStore([holder]);
    const notify = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set(), ntfyNotifier: { notifyBoardStallUnrecovered: notify } });
    manager.start();

    await manager.runBoardStallAutoRecoverySweep();
    byId.set("FN-21", makeTask("FN-21", { column: "todo", blockedBy: "FN-20" }));
    await manager.runBoardStallAutoRecoverySweep();
    (manager as any).maintenanceTickCounter++;
    await manager.runBoardStallAutoRecoverySweep();

    (manager as any).boardStallWindow.pendingVerification = { holderIds: ["FN-20"], followerCount: 1, startedAt: Date.now(), tick: 0 };
    (manager as any).maintenanceTickCounter++;
    await manager.runBoardStallAutoRecoverySweep();

    expect(notify).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("skips unrecovered notification when progress resumes", async () => {
    const holder = makeTask("FN-10", { column: "in-progress", paused: true, pausedReason: "waiting" });
    const { store, byId } = makeStore([holder]);
    const notify = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set(), ntfyNotifier: { notifyBoardStallUnrecovered: notify } });
    manager.start();

    await manager.runBoardStallAutoRecoverySweep();
    byId.set("FN-11", makeTask("FN-11", { column: "todo", blockedBy: "FN-10" }));
    await manager.runBoardStallAutoRecoverySweep();
    (manager as any).boardStallWindow.transitionsOutOfInProgressInWindow = 1;
    (manager as any).maintenanceTickCounter++;
    const verification = await manager.runBoardStallAutoRecoverySweep();
    expect(verification.unrecovered).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    manager.stop();
  });

  it("enforces cooldown for repeated unrecovered alerts", async () => {
    const holder = makeTask("FN-20", { column: "in-progress", paused: true, pausedReason: "waiting" });
    const { store, byId } = makeStore([holder]);
    const notify = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set(), ntfyNotifier: { notifyBoardStallUnrecovered: notify } });
    manager.start();

    await manager.runBoardStallAutoRecoverySweep();
    byId.set("FN-21", makeTask("FN-21", { column: "todo", blockedBy: "FN-20" }));
    await manager.runBoardStallAutoRecoverySweep();
    (manager as any).maintenanceTickCounter++;
    await manager.runBoardStallAutoRecoverySweep();

    (manager as any).boardStallWindow.pendingVerification = { holderIds: ["FN-20"], followerCount: 1, startedAt: Date.now(), tick: 0 };
    (manager as any).maintenanceTickCounter++;
    await manager.runBoardStallAutoRecoverySweep();

    expect(notify).toHaveBeenCalledTimes(1);
    manager.stop();
  });
});
