import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";

/*
FNXC:OverlapWaitSynchronization 2026-09-18-01:20:
Covers the self-healing side of FN-329's "release the file-scope wait wake, not just the display
marker" contract, reimplemented for a branch that had excluded it. Three independent sweeps clear
`task.overlapBlockedBy` for a holder that died/went terminal without ever publishing a normal
overlap-wait release: completion fan-out (reconcileCompletedTask), the periodic stale-blockedBy
sweep (clearStaleBlockedBy), and the dependency-blocking-lease deadlock breaker
(reconcileDependencyBlockingLeases). Each must invoke `options.onOverlapBlockersReleased` with
exactly the (taskId, blockerId) pairs it actually committed — never for a preserved/queued wait,
never before the durable clear lands.
*/

const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn(() => false) }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSyncMock };
});

const { logger } = vi.hoisted(() => ({
  logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../logger.js", () => ({ createLogger: vi.fn(() => logger) }));

import { SelfHealingManager } from "../self-healing.js";

const NOW_ISO = "2026-09-18T00:00:00.000Z";

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
    steps: [],
    log: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  } as Task;
}

function makeStore(tasksInput: Task[], settingsOverrides: Partial<Settings> = {}): { tasks: Map<string, Task>; store: TaskStore & EventEmitter } {
  const tasks = new Map(tasksInput.map((task) => [task.id, task]));
  const emitter = new EventEmitter();
  const settings: Settings = { globalPause: false, enginePaused: false, ...settingsOverrides } as Settings;
  const store = Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async (opts?: { column?: Task["column"]; includeArchived?: boolean }) => {
      const all = [...tasks.values()];
      if (!opts?.column) return all;
      return all.filter((t) => t.column === opts.column);
    }),
    getTask: vi.fn(async (id: string) => tasks.get(id) ?? null),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`missing ${id}`);
      const next = { ...current, ...patch } as Task;
      if (patch.overlapBlockedBy === null) next.overlapBlockedBy = undefined;
      tasks.set(id, next);
      return next;
    }),
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`missing ${id}`);
      const next = { ...current, column } as Task;
      tasks.set(id, next);
      return next;
    }),
    transitionQueuedEpisode: vi.fn(async (id: string, transition: { signature: string; blockedBy: string | null; overlapBlockedBy: string | null; action: string }) => {
      const current = tasks.get(id)!;
      const appended = !(current.status === "queued"
        && (current.blockedBy ?? null) === transition.blockedBy
        && (current.overlapBlockedBy ?? null) === transition.overlapBlockedBy);
      const next = { ...current, status: "queued", blockedBy: transition.blockedBy, overlapBlockedBy: transition.overlapBlockedBy } as Task;
      tasks.set(id, next);
      return { appended, task: next };
    }),
    logEntry: vi.fn(async () => undefined),
    parseFileScopeFromPrompt: vi.fn(async () => ["packages/engine/src/self-healing.ts"]),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
  return { tasks, store };
}

describe("self-healing overlap-wait release wake", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reconcileCompletedTask wakes the exact dependent whose overlap blocker it cleared, and only that one", async () => {
    const blocker = makeTask("FN-B", { column: "done" });
    const dependent = makeTask("FN-WAITING", { column: "todo", status: "queued", overlapBlockedBy: "FN-B" });
    const unrelated = makeTask("FN-UNRELATED", { column: "todo" });
    const { store } = makeStore([blocker, dependent, unrelated]);
    const onOverlapBlockersReleased = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", onOverlapBlockersReleased });

    await manager.reconcileCompletedTask("FN-B");

    expect(onOverlapBlockersReleased).toHaveBeenCalledTimes(1);
    expect(onOverlapBlockersReleased).toHaveBeenCalledWith([{ taskId: "FN-WAITING", blockerId: "FN-B" }]);
  });

  it("reconcileCompletedTask does not wake anything when no dependent was overlap-blocked", async () => {
    const blocker = makeTask("FN-B", { column: "done" });
    const dependent = makeTask("FN-DEP", { column: "todo", blockedBy: "FN-B", dependencies: ["FN-B"] });
    const { store } = makeStore([blocker, dependent]);
    const onOverlapBlockersReleased = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", onOverlapBlockersReleased });

    await manager.reconcileCompletedTask("FN-B");

    expect(onOverlapBlockersReleased).not.toHaveBeenCalled();
  });

  it("reconcileCompletedTask tolerates a throwing/rejecting release callback without affecting its own result", async () => {
    const blocker = makeTask("FN-B", { column: "done" });
    const dependent = makeTask("FN-WAITING", { column: "todo", status: "queued", overlapBlockedBy: "FN-B" });
    const { store, tasks } = makeStore([blocker, dependent]);
    const onOverlapBlockersReleased = vi.fn(async () => { throw new Error("wake sink down"); });
    const manager = new SelfHealingManager(store, { rootDir: "/repo", onOverlapBlockersReleased });

    const result = await manager.reconcileCompletedTask("FN-B");

    expect(result.blockedByCleared).toBe(1);
    expect(tasks.get("FN-WAITING")?.overlapBlockedBy).toBeUndefined();
    expect(onOverlapBlockersReleased).toHaveBeenCalledTimes(1);
  });

  it("clearStaleBlockedBy wakes a dependent once its terminal holder's stale overlap marker is cleared", async () => {
    const holder = makeTask("FN-HOLDER", { column: "done" });
    const dependent = makeTask("FN-DEPENDENT", { column: "todo", status: "queued", overlapBlockedBy: "FN-HOLDER" });
    const { store, tasks } = makeStore([holder, dependent]);
    const onOverlapBlockersReleased = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", onOverlapBlockersReleased });

    // FN-5434: this specific "queued overlap wait, blocker now inactive" cleanup is
    // deliberately silent (no `recovered` increment) — assert the state change and the release
    // wake, not the counter.
    await manager.clearStaleBlockedBy();

    expect(tasks.get("FN-DEPENDENT")).toMatchObject({ overlapBlockedBy: undefined, status: null });
    expect(onOverlapBlockersReleased).toHaveBeenCalledWith([{ taskId: "FN-DEPENDENT", blockerId: "FN-HOLDER" }]);
  });

  it("clearStaleBlockedBy does not wake anything while the overlap blocker is preserved (still active)", async () => {
    const holder = makeTask("FN-HOLDER", { column: "in-progress", worktree: "/wt/fn-holder" });
    const dependent = makeTask("FN-DEPENDENT", {
      column: "todo", status: "queued", overlapBlockedBy: "FN-HOLDER", blockedBy: "FN-HOLDER", dependencies: ["FN-HOLDER"],
    });
    const { store } = makeStore([holder, dependent]);
    const onOverlapBlockersReleased = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", onOverlapBlockersReleased });

    await manager.clearStaleBlockedBy();

    expect(onOverlapBlockersReleased).not.toHaveBeenCalled();
  });
});
