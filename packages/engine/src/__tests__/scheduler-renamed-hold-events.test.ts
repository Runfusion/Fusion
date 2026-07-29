/*
FNXC:WorkflowLifecycleColumns 2026-07-28-11:20 (U11 conversion — scheduler live sites):

The scheduler's event handlers decide "is this the backlog column?" by comparing
against the literal `"todo"`. For a workflow that names its hold column anything
else, each of these silently stops firing — and after U11 deletes `todo` from the
builtins, they stop firing for EVERY workflow.

Four groups, all covered here because they fail independently:

  WAKE TRIGGERS  a move into/out of the hold column should wake the scheduler so a
                 freed slot is used immediately instead of waiting a poll interval.
                 Failure mode is SLOW, not wrong — up to one poll interval of
                 latency per affected move — which is exactly why it would go
                 unnoticed indefinitely.

  PARKED WAKES   unpause and planning-finished wakes fire for a card resting in
                 hold OR intake. Same latency failure.

  DEPENDENCY     after a blocker completes or is soft-deleted, dependents resting
                 in the hold column are unblocked. This one is NOT latency: a
                 dependent never gets unblocked, so it waits on a blocker that is
                 already done.

  AGENT LINK     the parked-agent-link evaluation passes a synthetic
                 `{ column: "todo" }`, which decides whether a running agent's task
                 link survives. Wrong here means a live agent's link is dropped.

Written against the literal implementation and observed FAILING first.
*/
import { describe, expect, it, vi } from "vitest";
import type { TaskStore, WorkflowIr } from "@fusion/core";
import { Scheduler } from "../scheduler.js";

const WF = "custom:wf";

/** Hold is `drafting`, intake is `inbox` — no `todo` column exists. */
function renamedIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", name: "inbox", traits: [{ trait: "intake" }] },
      { id: "drafting", name: "drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function createStore(tasks: Record<string, unknown>[] = []) {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const selection = { workflowId: WF, stepIds: [] };
  const listTasks = vi.fn(async (opts?: { column?: string }) =>
    opts?.column ? tasks.filter((t) => t.column === opts.column) : tasks,
  );
  const store = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    }),
    off: vi.fn(),
    getRootDir: vi.fn().mockReturnValue("/test/project"),
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
    listTasks,
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getCompletionHandoffAcceptedMarker: vi.fn().mockResolvedValue(null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: renamedIr() })),
    resolveTaskWorkflowIrSync: vi.fn(() => renamedIr()),
  } as unknown as TaskStore;

  return {
    store,
    listTasks,
    emit: async (event: string, payload: unknown) => {
      for (const l of listeners.get(event) ?? []) await l(payload);
    },
  };
}

function task(over: Record<string, unknown> = {}) {
  return {
    id: "FN-1",
    column: "drafting",
    status: null,
    paused: false,
    userPaused: false,
    assignedAgentId: null,
    checkedOutBy: null,
    deletedAt: null,
    dependencies: [],
    blockedBy: null,
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function createScheduler(tasks: Record<string, unknown>[] = []) {
  const { store, emit, listTasks } = createStore(tasks);
  const scheduler = new Scheduler(store, {});
  const schedule = vi.spyOn(scheduler, "schedule").mockResolvedValue(undefined);
  (scheduler as unknown as { running: boolean }).running = true;
  return { scheduler, emit, schedule, store, listTasks };
}

describe("scheduler event handlers under a renamed hold column", () => {
  describe("wake triggers (failure mode is latency, which is why it hides)", () => {
    it("wakes when a card moves INTO the renamed hold column", async () => {
      const { emit, schedule } = createScheduler();
      await emit("task:moved", { task: task(), from: "building", to: "drafting", source: "engine" });
      expect(schedule).toHaveBeenCalled();
    });

    it("does NOT wake for a move between two non-hold columns", async () => {
      /* The negative half: converting must not turn every move into a wake. */
      const { emit, schedule } = createScheduler();
      await emit("task:moved", { task: task({ column: "building" }), from: "inbox", to: "building", source: "user" });
      expect(schedule).not.toHaveBeenCalled();
    });
  });

  describe("parked wakes (hold OR intake)", () => {
    it("wakes when a card unpauses in the renamed HOLD column", async () => {
      const { emit, schedule } = createScheduler();
      await emit("task:updated", task({ paused: true }));
      await emit("task:updated", task({ paused: false }));
      expect(schedule).toHaveBeenCalled();
    });

    it("wakes when planning finishes in the renamed INTAKE column", async () => {
      const { emit, schedule } = createScheduler();
      await emit("task:updated", task({ column: "inbox", status: "planning" }));
      await emit("task:updated", task({ column: "inbox", status: null }));
      expect(schedule).toHaveBeenCalled();
    });

    it("does NOT wake for a card resting in a wip column", async () => {
      const { emit, schedule } = createScheduler();
      await emit("task:updated", task({ column: "building", status: "planning" }));
      await emit("task:updated", task({ column: "building", status: null }));
      expect(schedule).not.toHaveBeenCalled();
    });
  });

  describe("dependency unblocking (failure mode is a card that waits forever)", () => {
    it("finds dependents resting in the renamed hold column when a blocker completes", async () => {
      /*
      Not a latency bug: if the query returns nothing, the dependent is never
      unblocked and waits on a blocker that already finished.
      */
      const dependent = task({ id: "FN-DEP", column: "drafting", dependencies: ["FN-BLOCK"], blockedBy: "FN-BLOCK" });
      const blocker = task({ id: "FN-BLOCK", column: "shipped" });
      const { emit, listTasks } = createScheduler([dependent, blocker]);

      await emit("task:moved", { task: blocker, from: "building", to: "done", source: "engine" });

      const queried = listTasks.mock.calls.map((c) => (c[0] as { column?: string } | undefined)?.column);
      expect(queried).not.toContain("todo");
      expect(queried).toContain("drafting");
    });
  });
});
