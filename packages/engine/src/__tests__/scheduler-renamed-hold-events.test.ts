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
import { toTaskMoveLanes } from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import { evaluateParkedAgentTaskLink } from "../task-agent-sync.js";
import { flushAsyncHandlers } from "./_flush-async-handlers.js";

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

/*
FNXC:WorkflowResolvedColumns 2026-08-01-05:01:
With no `resolveTaskWorkflowIrSync` fixture, this exact command first produced 3 failed / 9 passed:
renamed-hold wake, renamed-hold dependency lookup, and second complete-trait terminal handling. After
FN-8656 moved await-safe scheduler arms to the async resolver, it produces 12 passed / 0 failed:
`pnpm --filter @fusion/engine exec vitest run src/__tests__/scheduler-renamed-hold-events.test.ts --silent=passed-only --reporter=dot`.

The lane-less emits below are intentional. Reverting those arms to the sync resolver restores the
same three failures, proving the async fallback rather than a supplied payload resolves this fixture.
*/
function createStore(tasks: Record<string, unknown>[] = [], ir: WorkflowIr = renamedIr()) {
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
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
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

/*
FNXC:WorkflowLifecycleColumns 2026-07-29-17:20 (PR #2518 review — coderabbit):
Agent-link coverage needs a real `agentStore` plus the live-execution signal, so
the harness takes both. `hasActiveAgentExecution` is the ONLY difference between
the preserve and clear cases below — the safeguard must turn on live proof, not
on the column vocabulary.
*/
function createAgentStore(agents: Record<string, unknown>[], freshRun: unknown = null) {
  const updateAgentState = vi.fn().mockResolvedValue(undefined);
  const syncExecutionTaskLink = vi.fn().mockResolvedValue(undefined);
  return {
    agentStore: {
      listAgents: vi.fn(async () => agents),
      getActiveHeartbeatRun: vi.fn(async () => freshRun),
      updateAgentState,
      syncExecutionTaskLink,
    },
    updateAgentState,
    syncExecutionTaskLink,
  };
}

function createScheduler(
  tasks: Record<string, unknown>[] = [],
  options: Record<string, unknown> = {},
  ir: WorkflowIr = renamedIr(),
) {
  const { store, emit, listTasks } = createStore(tasks, ir);
  const scheduler = new Scheduler(store, options as never);
  const schedule = vi.spyOn(scheduler, "schedule").mockResolvedValue(undefined);
  (scheduler as unknown as { running: boolean }).running = true;
  return { scheduler, emit, schedule, store, listTasks };
}

describe("scheduler event handlers under a renamed hold column", () => {
  describe("wake triggers (failure mode is latency, which is why it hides)", () => {
    it("wakes when a card moves INTO the renamed hold column", async () => {
      const { emit, schedule } = createScheduler();
      await emit("task:moved", { task: task(), from: "building", to: "drafting", source: "engine" });
      await flushAsyncHandlers();
      expect(schedule).toHaveBeenCalled();
    });

    it("does NOT wake for a move between two non-hold columns", async () => {
      /* The negative half: converting must not turn every move into a wake. */
      const { emit, schedule } = createScheduler();
      await emit("task:moved", { task: task({ column: "building" }), from: "inbox", to: "building", source: "user" });
      await flushAsyncHandlers();
      expect(schedule).not.toHaveBeenCalled();
    });
  });

  describe("parked wakes (hold OR intake)", () => {
    it("wakes when a card unpauses in the renamed HOLD column", async () => {
      const { emit, schedule } = createScheduler();
      await emit("task:updated", task({ paused: true }));
      await emit("task:updated", task({ paused: false }));
      await flushAsyncHandlers();
      expect(schedule).toHaveBeenCalled();
    });

    it("wakes when planning finishes in the renamed INTAKE column", async () => {
      const { emit, schedule } = createScheduler();
      await emit("task:updated", task({ column: "inbox", status: "planning" }));
      await emit("task:updated", task({ column: "inbox", status: null }));
      await flushAsyncHandlers();
      expect(schedule).toHaveBeenCalled();
    });

    it("does NOT wake for a card resting in a wip column", async () => {
      const { emit, schedule } = createScheduler();
      await emit("task:updated", task({ column: "building", status: "planning" }));
      await emit("task:updated", task({ column: "building", status: null }));
      await flushAsyncHandlers();
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

    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-12:40:
    THE SECOND COMPLETE LANE. The guard above used to ask `to === parked.complete`, and
    `resolveLifecycleColumns` answers FIRST MATCH PER ROLE — so on a board that declares two
    complete-trait columns, a blocker finishing in the second one reconciled nothing and its
    dependents waited forever on a blocker that was already done.

    That arity difference is invisible on a single-lane board, which is why the sibling case above
    passes either way and this one is needed to hold the membership shape in place.
    */
    it("treats a SECOND complete-trait column as terminal, not just the first", async () => {
      const twoCompleteLanes = renamedIr();
      (twoCompleteLanes as unknown as { columns: Record<string, unknown>[] }).columns.push({
        id: "released", name: "released", traits: [{ trait: "complete" }],
      });

      const dependent = task({ id: "FN-DEP", column: "drafting", dependencies: ["FN-BLOCK"], blockedBy: "FN-BLOCK" });
      const blocker = task({ id: "FN-BLOCK", column: "released" });
      const { emit, listTasks } = createScheduler([dependent, blocker], {}, twoCompleteLanes);

      await emit("task:moved", { task: blocker, from: "building", to: "released", source: "engine" });

      const queried = listTasks.mock.calls.map((c) => (c[0] as { column?: string } | undefined)?.column);
      expect(queried).toContain("drafting");
    });

    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-11:25 (u12 — the PRODUCTION emit shape):
    The case above emits WITHOUT lanes, which no production emitter does — all 12 call
    `toTaskMoveLanes` — so it exercises the sync-resolver fallback rather than the shipped path.
    Measured on the shipped path, supplying lanes fixed every other renamed-board case in this file
    (10 passed / 1 failed) and left exactly this one broken, because `TaskMoveLanes` carried one id
    per role and the scheduler rebuilt `terminal` from it. This asserts the fix at the seam that
    actually runs: a card landing in a SECOND complete-trait column unblocks its dependents.
    */
    it("treats a second complete-trait column as terminal when the emitter supplies lanes", async () => {
      const twoCompleteLanes = renamedIr();
      (twoCompleteLanes as unknown as { columns: Record<string, unknown>[] }).columns.push({
        id: "released", name: "released", traits: [{ trait: "complete" }],
      });

      const dependent = task({ id: "FN-DEP", column: "drafting", dependencies: ["FN-BLOCK"], blockedBy: "FN-BLOCK" });
      const blocker = task({ id: "FN-BLOCK", column: "released" });
      const { emit, listTasks } = createScheduler([dependent, blocker], {}, twoCompleteLanes);

      await emit("task:moved", {
        task: blocker, from: "building", to: "released", source: "engine",
        lanes: toTaskMoveLanes(twoCompleteLanes),
      });

      const queried = listTasks.mock.calls.map((c) => (c[0] as { column?: string } | undefined)?.column);
      expect(queried).toContain("drafting");
    });
  });

  describe("agent link (wrong here DROPS a live agent's task link)", () => {
    /*
    CORRECTED after mutation testing. The first version of these tests asserted
    that the literal synthetic column dropped a live agent's link — and reverting
    the conversion did NOT fail them, because the literal passed `{column:"todo"}`
    together with the helper's LEGACY default parked list. The pair was
    self-consistent, so it read as parked either way: this site's conversion is
    behaviour-NEUTRAL.

    What is actually load-bearing is that the synthetic column and `parkedColumns`
    travel TOGETHER. Drift between them — a resolved column checked against the
    legacy list, or the reverse — reads as unparked and clears a live agent's link.
    These tests pin the live-proof safeguard and that consistency invariant, which
    is what the site really depends on.
    */
    const runningAgent = { id: "AG-1", taskId: "FN-1", state: "running" };

    it("PRESERVES a live agent's link under the renamed hold column", async () => {
      const { agentStore, updateAgentState, syncExecutionTaskLink } = createAgentStore([runningAgent]);
      const { scheduler } = createScheduler([task()], {
        agentStore,
        hasActiveAgentExecution: () => true,
      });

      await (scheduler as unknown as {
        rollbackRunningAgentsForQueuedTodoTask: (id: string) => Promise<void>;
      }).rollbackRunningAgentsForQueuedTodoTask("FN-1");

      expect(updateAgentState).not.toHaveBeenCalled();
      expect(syncExecutionTaskLink).not.toHaveBeenCalled();
    });

    it("CLEARS the link when nothing proves the execution is live", async () => {
      /* The negative half. Without it the test above passes for a scheduler that
         preserves every link unconditionally, which would be a different bug. */
      const { agentStore, updateAgentState, syncExecutionTaskLink } = createAgentStore([runningAgent]);
      const { scheduler } = createScheduler([task()], {
        agentStore,
        hasActiveAgentExecution: () => false,
      });

      await (scheduler as unknown as {
        rollbackRunningAgentsForQueuedTodoTask: (id: string) => Promise<void>;
      }).rollbackRunningAgentsForQueuedTodoTask("FN-1");

      expect(updateAgentState).toHaveBeenCalledWith("AG-1", "active");
      expect(syncExecutionTaskLink).toHaveBeenCalledWith("AG-1", undefined);
    });

    it("leaves agents linked to OTHER tasks untouched", async () => {
      const { agentStore, updateAgentState } = createAgentStore([
        { id: "AG-2", taskId: "FN-OTHER", state: "running" },
      ]);
      const { scheduler } = createScheduler([task()], {
        agentStore,
        hasActiveAgentExecution: () => false,
      });

      await (scheduler as unknown as {
        rollbackRunningAgentsForQueuedTodoTask: (id: string) => Promise<void>;
      }).rollbackRunningAgentsForQueuedTodoTask("FN-1");

      expect(updateAgentState).not.toHaveBeenCalled();
    });

    it("drops the link when the synthetic column DRIFTS from parkedColumns", () => {
      /*
      The real defect this site can suffer, asserted against the helper directly
      because the scheduler passes the pair consistently by construction. If a
      future edit resolves one side and not the other, a live agent loses its task.
      */
      const drifted = evaluateParkedAgentTaskLink({
        agent: { id: "AG-1", taskId: "FN-1" },
        linkedTask: { column: "drafting" },
        hasActiveAgentExecution: () => true,
        parkedColumns: ["todo", "triage"],
      });
      expect(drifted.shouldPreserveParkedLink).toBe(false);

      const consistent = evaluateParkedAgentTaskLink({
        agent: { id: "AG-1", taskId: "FN-1" },
        linkedTask: { column: "drafting" },
        hasActiveAgentExecution: () => true,
        parkedColumns: ["drafting", "inbox"],
      });
      expect(consistent.shouldPreserveParkedLink).toBe(true);
    });
  });
});
