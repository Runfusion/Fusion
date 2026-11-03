/*
FNXC:CapacityGateFacts 2026-11-02-22:40 (RUFU-372 second revision):
Before this change ONE reason word — `capacity` — covered two unrelated waits, and the confusion was
measured, not theoretical: on SKEN-009, 98 of 152 `reason=capacity` suspensions in one 30-minute window
belonged to a single card in a project with ZERO in-progress cards and zero worktree holders. A monitor
counting capacity suspends was reporting an unrelievable structural wait as if it were relievable
pressure, and an operator reading the board had one sentence for both.

The split is only worth anything if it cannot drift back, so this file pins the four properties the
split has to keep:
1. the scheduler-owned hold→WIP seam parks under its OWN code, on both halves of the pair (the marker
   and the paired lifecycle event);
2. a real capacity refusal KEEPS `capacity`, so the class a monitor should count as pressure survives
   the split unchanged;
3. the refusal class carries the gate facts (identity, counts, holders) computed through the safe
   wrapper, and the seam class does not consult a pool at all;
4. the durable-park decision is keyed on the presence of `park`, NOT on the reason word — otherwise
   relabelling the seam would silently un-park precisely the cards whose flood this task exists to bound.

Harness mirrors `workflow-column-boundary-park-facts.test.ts` rather than importing its internals.
*/
import { describe, expect, it, vi } from "vitest";
import { getWorkflowEventBus, TransitionRejectionError, type Task, type WorkflowIr } from "@fusion/core";
import {
  createWorkflowColumnBoundary,
  CAPACITY_REFUSAL,
  SCHEDULER_OWNED_SEAM,
  WORKFLOW_DEFERRAL_REASONS,
} from "../workflows/workflow-column-boundary.js";

function irWith(columns: unknown[], nodes: unknown[], edges: unknown[]): WorkflowIr {
  return { version: "v2", name: "capacity-deferral-reason-split", columns, nodes, edges } as unknown as WorkflowIr;
}

/** A wip column with an EXPLICIT limit, so the refusal class names `columnWip` and not the read-through. */
const wipIr = () => irWith(
  [
    { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limit: 2 } }] },
    { id: "in-review", name: "In review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] },
  ],
  [
    { id: "code-review", kind: "optional-group", column: "in-review", config: {} },
    { id: "code-review-remediation", kind: "prompt", column: "in-progress", config: {} },
  ],
  [{ from: "code-review", to: "code-review-remediation", condition: "failure" }],
);

/** A hold column whose release condition is capacity, with the next node in the wip column. */
const holdIr = () => irWith(
  [
    { id: "todo", name: "To do", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limit: 2 } }] },
  ],
  [{ id: "execute", kind: "prompt", column: "in-progress", config: {} }],
  [],
);

const nodeIn = (ir: WorkflowIr, id: string) => ir.nodes.find((n) => n.id === id)!;

function capacityRefusal(occupants: number, limit: number) {
  return new TransitionRejectionError(
    {
      code: "capacity-exhausted",
      messageKey: "transition.rejected.capacityExhausted",
      retryable: true,
      capacity: { column: "in-progress", occupants, limit },
    },
    `Column 'in-progress' is at capacity (${occupants}/${limit})`,
  );
}

function holder(id: string, columnMovedAt: string): Task {
  return {
    id,
    column: "in-progress",
    columnMovedAt,
    updatedAt: columnMovedAt,
    assignedAgentId: "agent-x",
    steps: [],
    dependencies: [],
  } as unknown as Task;
}

/**
 * A store snapshot with two cards standing in `in-progress`, one of them for two hours. The timestamps
 * are built from the REAL clock because the ambient provider deliberately cannot carry a `now` — the
 * evaluator owns its own measurement instant, so a fixture that injected one would be asserting against
 * a clock the production path never uses. Age assertions are therefore floors.
 */
function storeWithHolders() {
  const now = Date.now();
  return {
    listTasks: async () => [
      holder("RUFU-H1", new Date(now - 2 * 60 * 60_000).toISOString()),
      holder("RUFU-H2", new Date(now - 5 * 60_000).toISOString()),
    ],
  };
}

describe("capacity deferrals — a structural seam park and a resource refusal are different reasons", () => {
  it("parks the hold→WIP seam under its own reason, on the marker AND its paired event", async () => {
    const ir = holdIr();
    const bus = getWorkflowEventBus();
    const suspendedEvents: Array<{ nodeId: string; reason?: string }> = [];
    const unsubscribe = bus.subscribe((event) => {
      if (event.type === "RunSuspended") suspendedEvents.push({ nodeId: event.nodeId, reason: event.reason });
    });
    const boundary = createWorkflowColumnBoundary({
      taskId: "RUFU-372S1",
      workflowId: "builtin:coding",
      ir,
      initialColumn: "todo",
      moveTask: async () => {},
      onSuspend: () => undefined,
    });

    try {
      const result = await boundary.onNodeEntry(nodeIn(ir, "execute"));

      expect(result).toMatchObject({ kind: "suspended", reason: SCHEDULER_OWNED_SEAM });
      // The event half must agree with the marker half, or a monitor counting events and a reader
      // counting the card's row disagree about which waits are capacity waits. The bus delivers on a
      // serial chain, so drain before reading what it saw.
      await bus.drain();
      expect(suspendedEvents).toEqual([{ nodeId: "execute", reason: SCHEDULER_OWNED_SEAM }]);
    } finally {
      unsubscribe();
    }
  });

  it("never consults a capacity pool at the seam, so the seam grows no gate facts", async () => {
    const ir = holdIr();
    const source = vi.fn(async () => ({ store: storeWithHolders() }));
    const boundary = createWorkflowColumnBoundary({
      taskId: "RUFU-372S2",
      workflowId: "builtin:coding",
      ir,
      initialColumn: "todo",
      moveTask: async () => {},
      capacityFactsSource: source,
    });

    const result = await boundary.onNodeEntry(nodeIn(ir, "execute"));

    // The seam performs no move, so it is never refused, so there is nothing to measure. Calling the
    // source here would invent a sample for a gate that was never asked.
    expect(source).not.toHaveBeenCalled();
    expect((result as { capacityFacts?: unknown }).capacityFacts).toBeUndefined();
  });

  it("keeps `capacity` for a real refusal and attaches the gate facts from one snapshot", async () => {
    const ir = wipIr();
    const bus = getWorkflowEventBus();
    const suspendedEvents: Array<{ reason?: string }> = [];
    const unsubscribe = bus.subscribe((event) => {
      if (event.type === "RunSuspended") suspendedEvents.push({ reason: event.reason });
    });
    const boundary = createWorkflowColumnBoundary({
      taskId: "RUFU-372R1",
      workflowId: "builtin:coding",
      ir,
      initialColumn: "in-review",
      moveTask: async () => {
        throw capacityRefusal(2, 2);
      },
      capacityFactsSource: async () => ({ store: storeWithHolders() }),
    });

    try {
      const result = await boundary.onNodeEntry(nodeIn(ir, "code-review-remediation"));

      expect(result).toMatchObject({
        kind: "suspended",
        reason: CAPACITY_REFUSAL,
        // The refusal's own triple names the ceiling, and the explicit wip config names it `columnWip`.
        capacityFacts: {
          capacityGate: "columnWip",
          capacityLimit: 2,
          capacityUsed: 2,
          capacityHeldBy: ["RUFU-H1", "RUFU-H2"],
          capacityComputeOutcome: "complete",
          capacityStoreOutcome: "ok",
        },
      });
      // Ages are measured against the evaluator's own instant, so assert the floor, not the millisecond.
      expect((result as { capacityFacts?: { capacityOldestHolderAgeMs?: number } }).capacityFacts?.capacityOldestHolderAgeMs)
        .toBeGreaterThanOrEqual(2 * 60 * 60_000 - 5_000);
      await bus.drain();
      expect(suspendedEvents).toEqual([{ reason: CAPACITY_REFUSAL }]);
    } finally {
      unsubscribe();
    }
  });

  it("carries the holders onto the durable park so the card face can name them", async () => {
    const ir = wipIr();
    const boundary = createWorkflowColumnBoundary({
      taskId: "RUFU-372R2",
      workflowId: "builtin:coding",
      ir,
      initialColumn: "in-review",
      moveTask: async () => {
        throw capacityRefusal(2, 2);
      },
      capacityFactsSource: async () => ({ store: storeWithHolders() }),
    });

    const result = await boundary.onNodeEntry(nodeIn(ir, "code-review-remediation"));
    const park = (result as { park?: Record<string, unknown> }).park as Record<string, unknown>;

    expect(park).toMatchObject({
      code: "column-capacity",
      eligible: true,
      poolId: "in-progress",
      occupants: 2,
      limit: 2,
      holderIds: ["RUFU-H1", "RUFU-H2"],
    });
    expect(typeof park.oldestHolderAgeMs).toBe("number");
    expect(park.oldestHolderAgeMs as number).toBeGreaterThanOrEqual(2 * 60 * 60_000 - 5_000);
  });

  it("refuses with no wired facts source and stays byte-identical to the pre-fix payload", async () => {
    const ir = wipIr();
    const boundary = createWorkflowColumnBoundary({
      taskId: "RUFU-372R3",
      workflowId: "builtin:coding",
      ir,
      initialColumn: "in-review",
      moveTask: async () => {
        throw capacityRefusal(2, 2);
      },
    });

    const result = await boundary.onNodeEntry(nodeIn(ir, "code-review-remediation"));

    // A minimal harness must not gain a key it never asked for: absence here is the byte-compatibility
    // contract every store-less wiring depends on, not a gap to fill with nulls.
    expect(Object.keys(result as object)).not.toContain("capacityFacts");
    // The refusal still parks, and its park still carries the raw triple.
    expect((result as { park?: Record<string, unknown> }).park).toMatchObject({
      code: "column-capacity",
      poolId: "in-progress",
      occupants: 2,
      limit: 2,
    });
  });

  it("keeps the two reason codes in one shared vocabulary the executor can switch on", () => {
    // The executor's suspended marker and the boundary result share this union, so a producer cannot
    // invent a third spelling of a deferral the audit reader has never seen.
    expect(WORKFLOW_DEFERRAL_REASONS).toContain(CAPACITY_REFUSAL);
    expect(WORKFLOW_DEFERRAL_REASONS).toContain(SCHEDULER_OWNED_SEAM);
    expect(CAPACITY_REFUSAL).not.toBe(SCHEDULER_OWNED_SEAM);
  });
});
