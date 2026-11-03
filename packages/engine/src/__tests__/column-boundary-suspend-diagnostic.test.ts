/*
FNXC:RunAuditCapacityDiagnostic 2026-10-20-20:25 (RUFU-372):
A board that suspended 185 times in one hour across 27 cards with `live_exec=0` was undiagnosable,
because every `task:workflow-run-suspended` row carried only node/reason/columns. `reason: "capacity"`
covered two unrelated situations — the scheduler-owned hold→wip seam, which never consults a capacity
pool, and a real `capacity-exhausted` transition rejection whose refusal already knew the column, the
occupants and the limit. An operator could not tell a full WIP pool from a full worktree pool from a
wedged dispatcher, and neither could any later sweep.

The invariant these tests pin, end to end:

1. the boundary says WHICH refusal suspended the run, from a fixed vocabulary;
2. when a pool refused, the refusal's counts travel with it (never invented when absent);
3. the audit row surfaces those ids/counts, so the question "which gate, how full?" is answerable
   from the row alone;
4. RUFU-442's notice bound still holds — the counts describe the FIRST sample of an ongoing wait and
   must never become part of the wait's identity, or a polled full pool re-reports every pass.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import "./executor-test-helpers.js";
import { createMockStore } from "./executor-test-helpers.js";
import {
  deserializeTransitionRejection,
  evaluateCapacityRejection,
  makeCapacityRejection,
  serializeTransitionRejection,
  TransitionRejectionError,
  type Task,
  type WorkflowIr,
} from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { WorkflowGraphTaskRunner } from "../workflows/workflow-graph-task-runner.js";
import { createWorkflowColumnBoundary } from "../workflows/workflow-column-boundary.js";
import { createExecutorColumnBoundaryHooks } from "../workflow-column-boundary-hooks.js";
import { resetWorkflowRunSuspendedNoticeState } from "../executor/run-suspended-notice.js";

/** `intake → wip` needs both traits present so `isHoldToWipBoundary` is the branch that fires. */
function holdToWipIr(): WorkflowIr {
  return {
    version: "v2",
    name: "diagnostic-probe",
    columns: [
      { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    ],
    nodes: [{ id: "start", kind: "prompt", column: "in-progress", config: {} }],
    edges: [],
  } as unknown as WorkflowIr;
}

function reviewGateIr(): WorkflowIr {
  return {
    version: "v2",
    name: "diagnostic-probe-review",
    columns: [
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
      { id: "in-review", name: "In review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] },
    ],
    nodes: [
      { id: "code-review", kind: "optional-group", column: "in-review", config: {} },
      { id: "code-review-remediation", kind: "prompt", column: "in-progress", config: {} },
    ],
    edges: [{ from: "code-review", to: "code-review-remediation", condition: "failure" }],
  } as unknown as WorkflowIr;
}

/*
FNXC:CapacityGateFacts 2026-11-02-22:35 (RUFU-372 code review P1):
Same crossing as `reviewGateIr`, but the target column carries its OWN ceiling high enough that the
live column gate stays clear — so the ladder falls through to gate 2, the one the wiring used to be
unable to answer. A refusal that reached the ladder and then reported `capacityAgentGateError:
"unavailable"` was the whole P1: agent rows are not on a `TaskStore`.
*/
function agentGateReachableIr(): WorkflowIr {
  return {
    version: "v2",
    name: "diagnostic-probe-agent-gate",
    columns: [
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limit: 5 } }] },
      { id: "in-review", name: "In review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] },
    ],
    nodes: [
      { id: "code-review", kind: "optional-group", column: "in-review", config: {} },
      { id: "code-review-remediation", kind: "prompt", column: "in-progress", config: {} },
    ],
    edges: [{ from: "code-review", to: "code-review-remediation", condition: "failure" }],
  } as unknown as WorkflowIr;
}

/** A live occupant of `in-progress` owned by the deferred card's agent, holding since `ageMs`. */
function holder(id: string, ageMs: number): Task {
  const when = new Date(Date.now() - ageMs).toISOString();
  return {
    id,
    title: id,
    description: "",
    column: "in-progress",
    status: null,
    assignedAgentId: "agent-x",
    checkedOutBy: null,
    paused: false,
    userPaused: false,
    steps: [],
    dependencies: [],
    createdAt: when,
    updatedAt: when,
    columnMovedAt: when,
  } as unknown as Task;
}

/*
FNXC:CapacityGateFacts 2026-11-02-22:35 (RUFU-372 code review P1):
The production `TaskStore` shape: project settings and the task reads yes, `listAgents` NO — agent rows
live on `AgentStore`, reachable from the task store only through `getIntakeOwnerAgentStore()`. A fixture
that quietly kept `listAgents` would have passed against the broken wiring, so the key is deleted here
and re-asserted absent in the test below.
*/
function productionShapedTaskStore(holders: Task[], agents: unknown[]): Record<string, unknown> {
  const store = createMockStore() as Record<string, unknown>;
  delete store.listAgents;
  store.listTasks = vi.fn(async () => holders);
  store.getSettings = vi.fn(async () => ({ maxConcurrent: 8 }));
  store.getIntakeOwnerAgentStore = vi.fn(() => ({ listAgents: async () => agents }));
  return store;
}

const nodeIn = (ir: WorkflowIr, id: string) => ir.nodes.find((n) => n.id === id)!;

/** A refusal built the way the real policy builds one: prose plus the structured gate facts. */
function refusalWithFacts() {
  return new TransitionRejectionError(
    makeCapacityRejection(
      "transition.rejected.capacityExhausted",
      { column: "in-progress", occupants: 4, limit: 4 },
      "Column 'in-progress' is at capacity (4/4)",
    ),
    "Column 'in-progress' is at capacity (4/4)",
  );
}

/** The pre-RUFU-372 payload: code and prose only, no structured facts to forward. */
function refusalWithoutFacts() {
  return new TransitionRejectionError(
    { code: "capacity-exhausted", messageKey: "transition.rejected.capacityExhausted", retryable: true },
    "Column 'in-progress' is at capacity (4/4)",
  );
}

describe("column boundary — a suspend names the refusal that caused it", () => {
  it("labels the scheduler-owned hold→wip seam and reports NO capacity block", async () => {
    const boundary = createWorkflowColumnBoundary({
      taskId: "RUFU-372A",
      workflowId: "builtin:coding",
      ir: holdToWipIr(),
      initialColumn: "todo",
      moveTask: async () => {},
    });

    const result = await boundary.onNodeEntry(nodeIn(holdToWipIr(), "start"));

    /*
    FNXC:CapacityGateFacts 2026-11-02-21:55 (RUFU-372 second revision):
    `scheduler-owned-seam` + `suspendSource: "scheduler-seam"` is the pair a monitor reads: the reason
    says the wait is structural, the source says no capacity pool was ever consulted. The refusal class
    keeps `capacity` — see the sibling case below, which must stay byte-identical.
    */
    expect(result).toMatchObject({ kind: "suspended", reason: "scheduler-owned-seam", source: "scheduler-seam" });
    // The seam never asked a pool, so a count here would be a fabrication.
    expect((result as { capacity?: unknown }).capacity).toBeUndefined();
  });

  it("forwards the refusing gate's column, occupants and limit on a real capacity rejection", async () => {
    const boundary = createWorkflowColumnBoundary({
      taskId: "RUFU-372B",
      workflowId: "builtin:coding",
      ir: reviewGateIr(),
      initialColumn: "in-review",
      moveTask: async () => { throw refusalWithFacts(); },
    });

    const result = await boundary.onNodeEntry(nodeIn(reviewGateIr(), "code-review-remediation"));

    expect(result).toMatchObject({
      kind: "suspended",
      reason: "capacity",
      source: "column-capacity",
      capacity: { column: "in-progress", occupants: 4, limit: 4 },
    });
  });

  it("says a capacity refusal carried no facts instead of implying an empty pool", async () => {
    const boundary = createWorkflowColumnBoundary({
      taskId: "RUFU-372C",
      workflowId: "builtin:coding",
      ir: reviewGateIr(),
      initialColumn: "in-review",
      moveTask: async () => { throw refusalWithoutFacts(); },
    });

    const result = await boundary.onNodeEntry(nodeIn(reviewGateIr(), "code-review-remediation"));

    expect(result).toMatchObject({ kind: "suspended", source: "capacity-rejection-without-facts" });
    expect((result as { capacity?: unknown }).capacity).toBeUndefined();
  });

  it("names the agent gate for a refusal the real wiring enriches, on the store shape production has", async () => {
    /*
    FNXC:CapacityGateFacts 2026-11-02-22:35 (RUFU-372 code review P1):
    This is the enrichment at the OTHER production site — the hooks the runner hands the boundary — and
    it is the shape that was broken: `capacityFactsSource` passed a `TaskStore`, which has no
    `listAgents`, so gate 2 could never evaluate and every enriched row that reached it printed
    `capacityAgentGateError: "unavailable"` while claiming the agent gate as the knob to turn. The store
    here is built to match the real class (no `listAgents`), and the only agent surface is the one the
    task store owns. The refusal deliberately carries NO structured facts: a carried refusal names the
    column ceiling from its own triple and never reaches gate 2, so this is the class where the live
    ladder is the only source of a gate identity.
    */
    expect((createMockStore() as Record<string, unknown>).listAgents).toBeUndefined();
    const ir = agentGateReachableIr();
    const store = productionShapedTaskStore(
      [holder("RUFU-H1", 5 * 60_000), holder("RUFU-H2", 60_000)],
      [{ id: "agent-x", state: "running", maxConcurrentRuns: 2 }],
    );
    const hooks = createExecutorColumnBoundaryHooks({
      store: store as never,
      task: { id: "RUFU-372D", assignedAgentId: "agent-x", checkedOutBy: null },
      workflowRunId: "run-1",
    });
    const boundary = createWorkflowColumnBoundary({
      taskId: "RUFU-372D",
      workflowId: "builtin:coding",
      ir,
      initialColumn: "in-review",
      moveTask: async () => {
        throw refusalWithoutFacts();
      },
      capacityFactsSource: hooks.capacityFactsSource,
    });

    const result = await boundary.onNodeEntry(nodeIn(ir, "code-review-remediation"));

    const facts = (result as { capacityFacts?: Record<string, unknown> }).capacityFacts;
    expect(facts).toBeDefined();
    expect(facts!).toMatchObject({
      capacityGate: "schedulerAgentActive",
      capacityLimit: 2,
      capacityUsed: 2,
      capacityHeldBy: ["RUFU-H1", "RUFU-H2"],
    });
    expect("capacityAgentGateError" in facts!).toBe(false);
  });
});

describe("capacity refusal carries its gate as data, not only as prose", () => {
  it("evaluateCapacityRejection attaches the structured facts alongside the sentence", () => {
    const rejection = evaluateCapacityRejection("in-progress", { limit: 2, occupants: 2 });

    expect(rejection).toMatchObject({
      code: "capacity-exhausted",
      retryable: true,
      capacity: { column: "in-progress", occupants: 2, limit: 2 },
    });
    expect(rejection?.detail).toContain("at capacity (2/2)");
  });

  it("survives the serialize/deserialize hop that a persisted refusal takes", () => {
    const original = evaluateCapacityRejection("in-progress", { limit: 3, occupants: 5 });
    const restored = deserializeTransitionRejection(serializeTransitionRejection(original!));

    expect(restored?.capacity).toEqual({ column: "in-progress", occupants: 5, limit: 3 });
  });

  it("drops a malformed capacity block rather than throwing at a recovery path", () => {
    const json = JSON.stringify({
      code: "capacity-exhausted",
      messageKey: "transition.rejected.capacityExhausted",
      retryable: true,
      capacity: { column: "in-progress", occupants: "many" },
    });

    const restored = deserializeTransitionRejection(json);
    expect(restored?.code).toBe("capacity-exhausted");
    expect(restored?.capacity).toBeUndefined();
  });
});

describe("task:workflow-run-suspended row answers which gate and how full", () => {
  beforeEach(() => resetWorkflowRunSuspendedNoticeState());

  function harness(suspension: Record<string, unknown>) {
    const task = { id: "RUFU-372D", column: "in-progress", steps: [], dependencies: [] } as unknown as Task;
    const store = createMockStore() as any;
    store.getTask.mockResolvedValue(task);
    store.getSettings.mockResolvedValue({ experimentalFeatures: { workflowGraphExecutor: true } });
    store.getTaskWorkflowSelectionAsync = vi.fn().mockResolvedValue({ workflowId: "wf-d", stepIds: [] });
    store.getWorkflowDefinition = vi.fn().mockResolvedValue({
      id: "wf-d",
      ir: { version: "v2", columns: [], nodes: [], edges: [] },
    });
    store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockResolvedValue({
      disposition: "suspended",
      outcome: "failure",
      visitedNodeIds: [],
      suspension,
    } as any);
    const rows = () =>
      (store.recordRunAuditEvent.mock.calls as any[][])
        .map((c) => c[0])
        .filter((e) => e?.mutationType === "task:workflow-run-suspended");
    return { task, store, rows };
  }

  it("writes the gate identity and counts when the boundary knew them", async () => {
    const { task, store, rows } = harness({
      nodeId: "start",
      reason: "capacity",
      fromColumn: "todo",
      toColumn: "in-progress",
      source: "column-capacity",
      capacity: { column: "in-progress", occupants: 4, limit: 4 },
    });

    await (new TaskExecutor(store, "/repo") as any).executeWorkflowGraph(task);

    expect(rows()).toHaveLength(1);
    expect(rows()[0].metadata).toMatchObject({
      nodeId: "start",
      reason: "capacity",
      suspendSource: "column-capacity",
      capacityColumn: "in-progress",
      capacityOccupants: 4,
      capacityLimit: 4,
    });
  });

  it("names the scheduler seam without inventing capacity counts", async () => {
    const { task, store, rows } = harness({
      nodeId: "start",
      // FNXC:CapacityGateFacts 2026-11-02-21:58 (RUFU-372): the seam class's own reason code.
      reason: "scheduler-owned-seam",
      fromColumn: "todo",
      toColumn: "in-progress",
      source: "scheduler-seam",
    });

    await (new TaskExecutor(store, "/repo") as any).executeWorkflowGraph(task);

    const meta = rows()[0].metadata;
    expect(meta.suspendSource).toBe("scheduler-seam");
    expect("capacityColumn" in meta).toBe(false);
    expect("capacityOccupants" in meta).toBe(false);
    /*
    FNXC:CapacityGateFacts 2026-11-02-21:58 (RUFU-372 second revision):
    The seam's contract changed shape but not its honesty. Before the split the row said nothing; now it
    always answers, and an unprovable limit reads as `unknown` beside nulls rather than as missing keys —
    which is the point, because a row that omits the keys is indistinguishable from a build that never
    had them. What stays forbidden is a COUNT: the seam was never refused against a pool, so no limit and
    no occupancy number may appear. Occupant IDS are a different claim and are deliberately reported —
    "the column is empty right now" is the half of the SKEN-009 question an operator can otherwise never
    answer, and it comes from a snapshot the seam took itself, not from a refusal that never happened.
    */
    expect(meta.capacityGate).toBe("unknown");
    expect(meta.capacityLimit).toBe(null);
    expect(meta.capacityUsed).toBe(null);
    expect("capacityOccupants" in meta).toBe(false);
    expect(meta.capacityHeldBy).toEqual([]);
  });

  /*
  FNXC:RunSuspendedAuditBackoff 2026-10-07-18:40 (RUFU-442 follow-up) kept intact by RUFU-372:
  This is the assertion that protects the fix from itself. The occupant count changes as slots free, so
  folding it into the wait identity would make every poll of a full pool a NEW wait and restore the
  seven-rows-in-four-minutes flood. The counts describe the first sample; the bound decides the row.
  */
  it("keeps one row for an ongoing wait even as the refusal counts change", async () => {
    const first = harness({
      nodeId: "start",
      reason: "capacity",
      fromColumn: "todo",
      toColumn: "in-progress",
      source: "column-capacity",
      capacity: { column: "in-progress", occupants: 4, limit: 4 },
    });
    const exec = new TaskExecutor(first.store, "/repo") as any;
    await exec.executeWorkflowGraph(first.task);
    await exec.executeWorkflowGraph(first.task);

    expect(first.rows()).toHaveLength(1);
    expect(first.rows()[0].metadata.capacityOccupants).toBe(4);
  });
});
