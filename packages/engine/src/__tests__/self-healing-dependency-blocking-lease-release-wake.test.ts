import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";

/*
FNXC:OverlapWaitSynchronization 2026-09-18-01:22:
Isolated in its own file because it force-overrides `fileScopeLeaseBlocksCandidate` (@fusion/core)
to `true` for the whole module so `reconcileDependencyBlockingLeases`' FN-6292 deadlock-break path
actually rebounds instead of waiving (the real predicate waives whenever the deadlocking dependency
is the holder's own unmet dependency, which is exactly how this sweep discovers a candidate — see
self-healing-overlap-release-wake.test.ts for the other two sweeps, which do not need this override).
*/
vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return { ...actual, fileScopeLeaseBlocksCandidate: () => true };
});

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
    id, title: id, description: id, column: "todo", status: null, paused: false,
    blockedBy: null, overlapBlockedBy: null, dependencies: [], steps: [], log: [],
    createdAt: NOW_ISO, updatedAt: NOW_ISO,
    ...overrides,
  } as Task;
}

function makeStore(tasksInput: Task[], settingsOverrides: Partial<Settings> = {}): { tasks: Map<string, Task>; store: TaskStore & EventEmitter } {
  const tasks = new Map(tasksInput.map((task) => [task.id, task]));
  const emitter = new EventEmitter();
  const settings: Settings = { globalPause: false, enginePaused: false, ...settingsOverrides } as Settings;
  const store = Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async () => [...tasks.values()]),
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
    logEntry: vi.fn(async () => undefined),
    parseFileScopeFromPrompt: vi.fn(async () => ["packages/engine/src/self-healing.ts"]),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
  return { tasks, store };
}

describe("reconcileDependencyBlockingLeases overlap-wait release wake", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("wakes the freed dependency after rebounding its deadlocked holder", async () => {
    const holder = makeTask("FN-H", { column: "in-progress", dependencies: ["FN-D"], worktree: "/wt/fn-h" });
    const dependency = makeTask("FN-D", { column: "todo", status: "queued", overlapBlockedBy: "FN-H" });
    const { store, tasks } = makeStore([holder, dependency], { taskStuckTimeoutMs: 1_000 });
    const onOverlapBlockersReleased = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", onOverlapBlockersReleased });
    vi.spyOn(manager as unknown as { evaluateBackwardMoveTripleProof: (...args: unknown[]) => unknown }, "evaluateBackwardMoveTripleProof")
      .mockResolvedValue({ ok: true, stalenessMs: 10_000, reason: "test" });

    const recovered = await manager.reconcileDependencyBlockingLeases();

    expect(recovered).toBe(1);
    expect(tasks.get("FN-D")?.overlapBlockedBy).toBeUndefined();
    expect(onOverlapBlockersReleased).toHaveBeenCalledWith([{ taskId: "FN-D", blockerId: "FN-H" }]);
  });

  it("does not wake anything when the dependency's overlap marker did not name this holder", async () => {
    const holder = makeTask("FN-H", { column: "in-progress", dependencies: ["FN-D"], worktree: "/wt/fn-h" });
    const dependency = makeTask("FN-D", { column: "todo", status: "queued", overlapBlockedBy: "FN-OTHER" });
    const { store } = makeStore([holder, dependency], { taskStuckTimeoutMs: 1_000 });
    const onOverlapBlockersReleased = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", onOverlapBlockersReleased });
    vi.spyOn(manager as unknown as { evaluateBackwardMoveTripleProof: (...args: unknown[]) => unknown }, "evaluateBackwardMoveTripleProof")
      .mockResolvedValue({ ok: true, stalenessMs: 10_000, reason: "test" });

    await manager.reconcileDependencyBlockingLeases();

    expect(onOverlapBlockersReleased).not.toHaveBeenCalled();
  });
});
