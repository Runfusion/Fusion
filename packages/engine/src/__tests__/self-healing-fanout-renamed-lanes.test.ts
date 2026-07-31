/*
FNXC:WorkflowResolvedColumns 2026-07-31-14:45:
THE `task:moved` FAN-OUT ANSWERED EVERY LANE QUESTION WITH A LITERAL.

`taskMovedFanoutListener` decided three things by comparing column ids:

  - a move OUT of `in-progress` into `todo`/`in-review`/`done`/`archived` increments the
    board-stall transition counter,
  - a move INTO `in-review` triggers the branch-rebind reconciliation,
  - `in-review -> done` and `done -> archived` trigger the completion fan-out (worktree removal,
    dependent `blockedBy` clearing).

On a board that names its lanes anything else, all three stopped firing. Nothing errors: the
counter silently reads zero, worktrees are never reclaimed, and dependents keep a `blockedBy`
pointing at a blocker that already finished.

WHY A SYNC RESOLVER. `task:moved` is emitted synchronously, so an `await` in this listener defers
everything after it to a microtask and reorders this handler against every other subscriber — the
hazard the scheduler's own `resolveTaskParkedColumnsSync` header documents. The conversion uses the
store's sync IR path for that reason, which is a different seam from the `resolveProjectColumnsForRoles`
used by the async sweeps and needs its own coverage.

Driven through the REAL listener via `start()` + a real `task:moved` emit, not by calling the
private resolver: the contract is that the fan-out fires, not that a helper returns a set.
*/

import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

const { logger } = vi.hoisted(() => ({
  logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../logger.js", () => ({ createLogger: vi.fn(() => logger) }));

import { SelfHealingManager } from "../self-healing.js";

/** Hold `drafting`, wip `building`, review `reviewing`, complete `shipped`, archived `filed`. */
function renamedIr(): WorkflowIr {
  return {
    version: "v2",
    id: "custom:wf",
    nodes: [],
    edges: [],
    columns: [
      { id: "drafting", name: "drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "reviewing", name: "reviewing", traits: [{ trait: "merge" }] },
      { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
      { id: "filed", name: "filed", traits: [{ trait: "archived" }] },
    ],
  } as unknown as WorkflowIr;
}

function makeTask(id: string, column: string): Task {
  return {
    id,
    title: id,
    description: id,
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  } as unknown as Task;
}

function createStore(tasks: Task[], ir: WorkflowIr | null): TaskStore & EventEmitter {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const emitter = new EventEmitter();
  const cfg = { globalPause: false, enginePaused: false } as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => cfg),
    listTasks: vi.fn(async () => [...map.values()]),
    getTask: vi.fn(async (id: string) => map.get(id) ?? null),
    updateTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    /* The sync seam under test. `null` stands for a workflow that cannot be resolved. */
    resolveTaskWorkflowIrSync: vi.fn(() => {
      if (!ir) throw new Error("no workflow selection");
      return ir;
    }),
  }) as unknown as TaskStore & EventEmitter;
}

/** Starts the manager with its periodic maintenance suppressed — only the listener is under test. */
function startManager(store: TaskStore & EventEmitter) {
  const mgr = new SelfHealingManager(store, { rootDir: "/repo" });
  vi.spyOn(mgr as unknown as { startMaintenance: () => void }, "startMaintenance").mockImplementation(() => {});
  const reconcile = vi.spyOn(mgr, "reconcileCompletedTask").mockResolvedValue({
    blockedByCleared: 0, worktreeRemoved: false, branchRemoved: false,
  });
  const rebind = vi.spyOn(mgr, "reconcileInReviewBranchRebind").mockResolvedValue(0 as never);
  mgr.start();
  return { mgr, reconcile, rebind };
}

/** `task:moved` is synchronous; the handlers it starts are not, so let the microtasks drain. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("the self-healing task:moved fan-out on a renamed board", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("runs the completion fan-out for reviewing -> shipped", async () => {
    const task = makeTask("KB-1", "shipped");
    const store = createStore([task], renamedIr());
    const { mgr, reconcile } = startManager(store);

    store.emit("task:moved", { task, from: "reviewing", to: "shipped", source: "engine" });
    await settle();

    /* Keyed on `in-review -> done` this never fired: the worktree is never reclaimed and every
       dependent keeps a `blockedBy` pointing at a blocker that has already finished. */
    expect(reconcile).toHaveBeenCalledWith("KB-1", expect.anything());
    mgr.stop();
  });

  it("runs the completion fan-out for shipped -> filed", async () => {
    const task = makeTask("KB-2", "filed");
    const store = createStore([task], renamedIr());
    const { mgr, reconcile } = startManager(store);

    store.emit("task:moved", { task, from: "shipped", to: "filed", source: "engine" });
    await settle();

    expect(reconcile).toHaveBeenCalledWith("KB-2", expect.anything());
    mgr.stop();
  });

  it("triggers the branch rebind on a move into the renamed review lane", async () => {
    const task = makeTask("KB-3", "reviewing");
    const store = createStore([task], renamedIr());
    const { mgr, rebind } = startManager(store);

    store.emit("task:moved", { task, from: "building", to: "reviewing", source: "engine" });
    await settle();

    expect(rebind).toHaveBeenCalledWith({ includeTaskIds: new Set(["KB-3"]) });
    mgr.stop();
  });

  /*
  The paired negative. The conversion widens membership, so it must not turn EVERY move into a
  fan-out — a `building -> drafting` requeue is not a completion, and reconciling it would remove
  the worktree of a card that is about to run again.
  */
  it("does NOT run the completion fan-out for a requeue into the hold lane", async () => {
    const task = makeTask("KB-4", "drafting");
    const store = createStore([task], renamedIr());
    const { mgr, reconcile } = startManager(store);

    store.emit("task:moved", { task, from: "building", to: "drafting", source: "engine" });
    await settle();

    expect(reconcile).not.toHaveBeenCalled();
    mgr.stop();
  });

  /*
  CONTROL + fail-soft. A store that cannot resolve a workflow must answer with exactly the legacy
  ids — this is the path every unconverted board and every `synthesizeDefaultColumns` v1 upgrade
  takes, and an unseeded resolved set would switch the whole fan-out off for them.
  */
  it("still fires on the legacy ids when the workflow cannot be resolved", async () => {
    const task = makeTask("KB-5", "done");
    const store = createStore([task], null);
    const { mgr, reconcile } = startManager(store);

    store.emit("task:moved", { task, from: "in-review", to: "done", source: "engine" });
    await settle();

    expect(reconcile).toHaveBeenCalledWith("KB-5", expect.anything());
    mgr.stop();
  });
});
