/*
FNXC:CapacityGateFacts 2026-11-02-22:50 (RUFU-372 second revision):
`task:workflow-run-suspended` was countable but not diagnosable: 185 `reason=capacity` rows in an hour
across 27 cards with the engine at 0 leases told an operator nothing about WHICH gate bound, so a full
WIP pool, a full worktree pool, and a wedged dispatcher read identically. The first slice forwarded only
what a refusing branch already held; this file pins the second slice's rules at the single emit site:

1. every capacity-bearing row answers the gate question — `unknown` beside nulls is an ANSWER, and a row
   that omits the keys is indistinguishable from a build that never had them;
2. a non-capacity row (a pause, a structural `hold`) grows NO capacity keys, because keys there would
   claim a limit was consulted when none was;
3. the refusal class never re-samples the pool: the store already counted it at refusal time, so a second
   count would describe a different instant than the refusal it reports;
4. a structural seam park, which was never measured, pays for exactly one snapshot;
5. the counts stay OUT of the notice signature — folding a fluctuating number into wait identity is the
   exact defect RUFU-442 removed, and it is the property most likely to be "helpfully" added back.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { WorkflowGraphTaskRunner } from "../workflows/workflow-graph-task-runner.js";
import { resetWorkflowRunSuspendedNoticeState } from "../executor/run-suspended-notice.js";
import {
  HUMAN_MERGE_APPROVAL_HOLD_IR_HASH,
  WORKFLOW_PRINCIPAL_HOLD_IR_HASH,
} from "../workflows/workflow-column-boundary.js";
import { createMockStore } from "./executor-test-helpers.js";

/** The executor's repo root only needs to be a string here; no git work happens on these paths. */
const REPO = ".";

/*
FNXC:CapacityGateFacts 2026-11-02-22:05 (RUFU-372 code review P0):
The closed capacity-key set as ONE list, so a class that must stay evidence-free is asserted against
EVERY key rather than the subset one test happened to enumerate. `capacityStoreOutcome` and the raw
refusal triple belong to the set for the same reason as `capacityGate`: each asserts that a gate was
consulted, and a structural hold consulted none.
*/
const CAPACITY_METADATA_KEYS = [
  "capacityGate",
  "capacityLimit",
  "capacityUsed",
  "capacityHeldBy",
  "capacityOldestHolderAgeMs",
  "capacityComputeOutcome",
  "capacityStoreOutcome",
  "capacityColumn",
  "capacityOccupants",
] as const;

function holder(id: string, ageMs: number): Task {
  // Ages are measured against the evaluator's own `Date.now()`, so the fixture is built from the real
  // clock too; a fixed NOW would make every age assertion a race with wall-clock time.
  const movedAt = new Date(Date.now() - ageMs).toISOString();
  return {
    id,
    column: "in-progress",
    columnMovedAt: movedAt,
    updatedAt: movedAt,
    assignedAgentId: "agent-x",
    steps: [],
    dependencies: [],
  } as unknown as Task;
}

/**
 * The harness drives the real `executeWorkflowGraph` suspended branch with a faked runner disposition, so
 * what is under test is the emit site's own decisions (class gating, one-snapshot budget, key set) rather
 * than the boundary's, which has its own file.
 */
function harness(
  suspension: Record<string, unknown>,
  options: {
    listTasks?: () => Promise<Task[]>;
    /** The target column's explicit wip ceiling. Raise it to keep the column gate clear so a later
     *  gate (the agent gate) is the one that binds. */
    wipLimit?: number;
    /** Stands in for the engine's AgentStore — the store the agent rows actually live on. */
    agentStore?: unknown;
  } = {},
) {
  const task = {
    id: "RUFU-372E",
    column: "todo",
    steps: [],
    dependencies: [],
    assignedAgentId: "agent-x",
  } as unknown as Task;
  // Built on the shared executor mock store rather than a hand-rolled object: the executor's lifecycle
  // wiring subscribes to store events, and a literal would fail for reasons unrelated to what is under
  // test here (the same reason `column-boundary-suspend-diagnostic.test.ts` uses this helper).
  const store = createMockStore() as any;
  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({ maxConcurrent: 2, experimentalFeatures: { workflowGraphExecutor: true } });
  store.getTaskWorkflowSelectionAsync = vi.fn().mockResolvedValue({ workflowId: "wf-e", stepIds: [] });
  store.getWorkflowDefinition = vi.fn().mockResolvedValue({
    id: "wf-e",
    ir: {
      version: "v2",
      columns: [
        { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "external-event" } }] },
        { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limit: options.wipLimit ?? 2 } }] },
      ],
      nodes: [{ id: "start", kind: "prompt", column: "in-progress", config: {} }],
      edges: [],
    },
  });
  store.listTasks = vi.fn(options.listTasks ?? (async () => []));
  store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockResolvedValue({
    disposition: "suspended",
    outcome: "failure",
    visitedNodeIds: [],
    suspension,
  } as any);

  const rows = () =>
    (store.recordRunAuditEvent.mock.calls as any[][])
      .map((call) => call[0])
      .filter((entry) => entry?.mutationType === "task:workflow-run-suspended");

  return {
    task,
    store,
    rows,
    /* Passed to the executor's options bag so a test can wire the agent store the seam snapshot needs
       (RUFU-372 review P1). Every existing test ignores it and gets the pre-fix shape. */
    executorOptions: { agentStore: options.agentStore },
  };
}

describe("task:workflow-run-suspended — every capacity-bearing row answers the gate question", () => {
  beforeEach(() => {
    resetWorkflowRunSuspendedNoticeState();
    vi.useRealTimers();
  });

  it("answers with the refusal's own numbers and names the ceiling it came from", async () => {
    const { task, store, rows } = harness({
      nodeId: "start",
      reason: "capacity",
      fromColumn: "todo",
      toColumn: "in-progress",
      source: "column-capacity",
      capacity: { column: "in-progress", occupants: 2, limit: 2 },
    });

    await new TaskExecutor(store, REPO).executeWorkflowGraph(task);

    const meta = rows()[0].metadata;
    expect(meta).toMatchObject({
      reason: "capacity",
      suspendSource: "column-capacity",
      capacityGate: "columnWip",
      capacityLimit: 2,
      capacityUsed: 2,
      capacityComputeOutcome: "complete",
    });
    /*
    A refusal must not re-count the pool: the store refused against 2/2 and that is the instant this row
    reports. `listTasks` is the pool walk — its absence is the proof the row describes the refusal.
    */
    expect(store.listTasks).not.toHaveBeenCalled();
  });

  it("forwards gate facts the boundary already computed instead of sampling again", async () => {
    const boundaryFacts = {
      capacityGate: "maxConcurrent",
      capacityLimit: 4,
      capacityUsed: 4,
      capacityOldestHolderAgeMs: 60_000,
      capacityComputeOutcome: "complete",
      capacityStoreOutcome: "ok",
    };
    const { task, store, rows } = harness({
      nodeId: "start",
      reason: "capacity",
      fromColumn: "todo",
      toColumn: "in-progress",
      source: "column-capacity",
      capacity: { column: "in-progress", occupants: 4, limit: 4 },
      capacityFacts: boundaryFacts,
    });

    await new TaskExecutor(store, REPO).executeWorkflowGraph(task);

    // One measurement per event: the boundary's snapshot wins, so the audit row and the card's episode
    // describe the same instant instead of two samples taken a hop apart.
    expect(store.listTasks).not.toHaveBeenCalled();
    expect(rows()[0].metadata.capacityGate).toBe("maxConcurrent");
    expect(rows()[0].metadata.capacityLimit).toBe(4);
  });

  it("measures the pool exactly once for a structural seam that was never measured", async () => {
    const { task, store, rows } = harness(
      {
        nodeId: "start",
        reason: "scheduler-owned-seam",
        fromColumn: "todo",
        toColumn: "in-progress",
        source: "scheduler-seam",
      },
      { listTasks: async () => [holder("RUFU-H1", 3 * 60 * 60_000), holder("RUFU-H2", 60_000)] },
    );

    await new TaskExecutor(store, "/repo").executeWorkflowGraph(task);

    const meta = rows()[0].metadata;
    expect(store.listTasks).toHaveBeenCalledTimes(1);
    expect(meta).toMatchObject({
      reason: "scheduler-owned-seam",
      suspendSource: "scheduler-seam",
      // The seam was never refused, so nothing binds it: the live column read is the most a seam row may
      // honestly claim, and it is what tells an operator whether a slot is even free right now. Here the
      // pool really is full, so the row says so instead of staying silent.
      capacityGate: "columnWip",
      capacityLimit: 2,
      capacityUsed: 2,
      capacityHeldBy: ["RUFU-H1", "RUFU-H2"],
      capacityComputeOutcome: "complete",
    });
    // Age is measured against the evaluator's own clock, so assert the floor, not the exact millisecond.
    expect(meta.capacityOldestHolderAgeMs).toBeGreaterThanOrEqual(3 * 60 * 60_000 - 5_000);
  });

  it("answers a seam park whose pool is genuinely free rather than staying silent", async () => {
    const { task, store, rows } = harness({
      nodeId: "start",
      reason: "scheduler-owned-seam",
      fromColumn: "todo",
      toColumn: "in-progress",
      source: "scheduler-seam",
    });

    await new TaskExecutor(store as any, REPO).executeWorkflowGraph(task);

    // Zero occupants is the answer an operator needs, and it must not be laundered into a binding limit:
    // `capacityGate`/`capacityLimit`/`capacityUsed` describe the gate that BINDS (null when nothing binds),
    // while `capacityHeldBy` describes who occupies the target column right now. The SKEN-009 shape — a
    // card stuck at a seam while the pool sits empty — is therefore readable off one row.
    expect(rows()[0].metadata).toMatchObject({
      capacityGate: "unknown",
      capacityLimit: null,
      capacityUsed: null,
      capacityHeldBy: [],
      capacityComputeOutcome: "complete",
    });
  });

  it("grows no capacity keys on a pause or a structural hold", async () => {
    for (const reason of ["pause", "hold"]) {
      resetWorkflowRunSuspendedNoticeState();
      const { task, store, rows } = harness({
        nodeId: "start",
        reason,
        fromColumn: "in-progress",
        toColumn: "in-progress",
      });

      await new TaskExecutor(store, REPO).executeWorkflowGraph(task);

      const meta = rows()[0].metadata;
      expect(meta.reason).toBe(reason);
      // Keys here would assert a limit was consulted.
      for (const key of CAPACITY_METADATA_KEYS) {
        expect(key in meta).toBe(false);
      }
      expect(store.listTasks).not.toHaveBeenCalled();
    }
  });

  it("grows no capacity keys on a structural hold whose reason SAYS capacity", async () => {
    /*
    FNXC:CapacityGateFacts 2026-11-02-22:05 (RUFU-372 code review P0):
    The pause/hold loop above cannot reach this shape, and that is the whole defect. The
    principal-routing / overlap-wait hold suspends with `reason: "capacity"` and carries its identity in
    the marker's `irHash`, so a class test keyed on the reason alone handed it the refusal arm: one row
    carrying `capacityGate: "unknown"` that a `reason=capacity` monitor also counts — a misleading
    unknown AND an inflated refusal count, invisible from the inside because nothing in the row looked
    wrong. The sentinel is therefore classified BEFORE the reason, and this fixture asserts both halves:
    the row stays evidence-free, and it never pays for a pool walk.
    */
    for (const marker of [
      // The reachable one: a structural hold that reports as a capacity refusal.
      { reason: "capacity", irHash: WORKFLOW_PRINCIPAL_HOLD_IR_HASH },
      // The other sentinel: identical semantics, already hidden by the reason test by luck.
      { reason: "hold", irHash: HUMAN_MERGE_APPROVAL_HOLD_IR_HASH },
    ]) {
      resetWorkflowRunSuspendedNoticeState();
      const { task, store, rows } = harness({
        nodeId: "start",
        reason: marker.reason,
        irHash: marker.irHash,
        fromColumn: "todo",
        toColumn: "in-progress",
      });

      await new TaskExecutor(store, REPO).executeWorkflowGraph(task);

      const meta = rows()[0].metadata;
      // The deferral class still reports honestly — the sentinel travel is what changed, not the word.
      expect(meta.reason).toBe(marker.reason);
      for (const key of CAPACITY_METADATA_KEYS) {
        expect(key in meta).toBe(false);
      }
      expect(store.listTasks).not.toHaveBeenCalled();
    }
  });

  it("names the agent gate from a seam snapshot wired through the store the agent rows live on", async () => {
    /*
    FNXC:CapacityGateFacts 2026-11-02-22:05 (RUFU-372 code review P1):
    The seam snapshot was handed a `TaskStore`, which has no `listAgents` — agent rows live on
    `AgentStore`. So the gate RunFusion's wrong guesses were actually about (`schedulerAgentActive`) was
    unreachable from every production deferral, and each seam row for a card with an owner printed
    `capacityAgentGateError: "unavailable"` while the column numbers were already in the row. This store
    is deliberately the production shape: task reads, no `listAgents`. The ceiling is raised past the
    occupancy so the column gate stays clear and the agent gate is the one that binds.
    */
    const { task, store, rows, executorOptions } = harness(
      {
        nodeId: "start",
        reason: "scheduler-owned-seam",
        fromColumn: "todo",
        toColumn: "in-progress",
        source: "scheduler-seam",
      },
      {
        wipLimit: 5,
        listTasks: async () => [holder("RUFU-H1", 5 * 60_000), holder("RUFU-H2", 60_000)],
        agentStore: { listAgents: async () => [{ id: "agent-x", state: "running", maxConcurrentRuns: 2 }] },
      },
    );
    expect(store.listAgents).toBeUndefined();

    await new TaskExecutor(store, REPO, executorOptions as any).executeWorkflowGraph(task);

    const meta = rows()[0].metadata;
    expect(meta.capacityGate).toBe("schedulerAgentActive");
    expect(meta.capacityLimit).toBe(2);
    expect(meta.capacityUsed).toBe(2);
    expect(meta.capacityHeldBy).toEqual(["RUFU-H1", "RUFU-H2"]);
    // The failure key must be gone, not merely co-present: an operator reading `unavailable` here would
    // conclude the wiring is missing when the gate really is full.
    expect("capacityAgentGateError" in meta).toBe(false);
  });

  it("keeps the fluctuating numbers out of the notice signature", async () => {
    const first = harness({
      nodeId: "start",
      reason: "capacity",
      fromColumn: "todo",
      toColumn: "in-progress",
      source: "column-capacity",
      capacity: { column: "in-progress", occupants: 2, limit: 2 },
    });
    const executor = new TaskExecutor(first.store, REPO);
    await executor.executeWorkflowGraph(first.task);
    // A re-dispatch of the SAME wait must stay one row even though the pool's occupancy would have
    // moved between the two passes: RUFU-442's measured failure was a bound whose key churned.
    await executor.executeWorkflowGraph(first.task);

    expect(first.rows()).toHaveLength(1);
  });
});
