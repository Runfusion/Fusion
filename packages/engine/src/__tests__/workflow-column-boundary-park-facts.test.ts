/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The park facts are what turn a suspension into a diagnosable wait. RUFU-372 could already name the refusing
column and its counts on the audit row, but nothing told the CARD which gate refused it, so the durable
episode had no code to store. Two shapes must stay distinguishable, because collapsing them is the exact
defect RUFU-372 was written for: a `scheduler-seam` suspension never consulted a capacity pool and therefore
carries NO pool facts at all — an absent count means "no pool was asked", never "an empty pool" — while a
real `capacity-exhausted` rejection carries them. The `eligible` flag is the other half: a hold released by
a person or an external event is not a capacity wait, and parking it as one sends an operator hunting a
limit that was never binding.

Harness deliberately mirrors `workflow-column-boundary-capacity.test.ts` rather than importing from it: that
file's IR and error builders are local helpers, and duplicating a few lines is cheaper than exporting test
internals from a sibling test module.
*/
import { describe, expect, it, vi } from "vitest";
import { TransitionRejectionError, type WorkflowIr } from "@fusion/core";
import { createWorkflowColumnBoundary } from "../workflows/workflow-column-boundary.js";

function irWith(columns: unknown[], nodes: unknown[], edges: unknown[]): WorkflowIr {
  return { version: "v2", name: "wip-admission-park-facts", columns, nodes, edges } as unknown as WorkflowIr;
}

const wipIr = () => irWith(
  [
    { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
    { id: "in-review", name: "In review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] },
  ],
  [
    { id: "code-review", kind: "optional-group", column: "in-review", config: {} },
    { id: "code-review-remediation", kind: "prompt", column: "in-progress", config: {} },
  ],
  [{ from: "code-review", to: "code-review-remediation", condition: "failure" }],
);

/** A hold column released by `release`, whose next node lives in the wip column. */
const holdIr = (release: string) => irWith(
  [
    { id: "todo", name: "To do", traits: [{ trait: "hold", config: { release } }] },
    { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
  ],
  [{ id: "execute", kind: "prompt", column: "in-progress", config: {} }],
  [],
);

const nodeIn = (ir: WorkflowIr, id: string) => ir.nodes.find((n) => n.id === id)!;

function capacityErrorWithFacts(occupants: number, limit: number) {
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

/** The pre-RUFU-372 rejection shape: capacity was the code, but no structured facts rode with it. */
function capacityErrorWithoutFacts() {
  return new TransitionRejectionError(
    { code: "capacity-exhausted", messageKey: "transition.rejected.capacityExhausted", retryable: true },
    "Column 'in-progress' is at capacity (4/4)",
  );
}

function parkOf(result: unknown): Record<string, unknown> {
  return (result as { park?: Record<string, unknown> }).park as Record<string, unknown>;
}

describe("workflow column boundary — park facts on a withheld crossing", () => {
  it("attaches the measured pool facts and marks the crossing park-eligible on a real capacity rejection", async () => {
    const ir = wipIr();
    const boundary = createWorkflowColumnBoundary({
      taskId: "FN-PARK1",
      workflowId: "builtin:coding",
      ir,
      initialColumn: "in-review",
      moveTask: vi.fn().mockRejectedValue(capacityErrorWithFacts(4, 4)),
      onSuspend: vi.fn(),
    });

    const result = await boundary.onNodeEntry(nodeIn(ir, "code-review-remediation"));
    expect(result).toMatchObject({
      kind: "suspended",
      reason: "capacity",
      park: { code: "column-capacity", eligible: true, poolId: "in-progress", occupants: 4, limit: 4 },
    });
  });

  it("labels an unproven capacity refusal as unproven rather than inventing a column", async () => {
    const ir = wipIr();
    const boundary = createWorkflowColumnBoundary({
      taskId: "FN-PARK2",
      workflowId: "builtin:coding",
      ir,
      initialColumn: "in-review",
      moveTask: vi.fn().mockRejectedValue(capacityErrorWithoutFacts()),
      onSuspend: vi.fn(),
    });

    const result = await boundary.onNodeEntry(nodeIn(ir, "code-review-remediation"));
    expect(result).toMatchObject({ kind: "suspended", park: { code: "capacity-rejection-without-facts", eligible: true } });
    const park = parkOf(result);
    expect(park).not.toHaveProperty("poolId");
    expect(park).not.toHaveProperty("occupants");
  });

  it("reports a scheduler-seam suspension with no pool facts, because no pool was consulted", async () => {
    // KTD-2: the graph never moves a hold->wip crossing, so the card suspends at the seam having
    // never asked a capacity pool. An absent count must mean "no pool was asked".
    const ir = holdIr("capacity");
    const boundary = createWorkflowColumnBoundary({
      taskId: "FN-PARK3",
      workflowId: "builtin:coding",
      ir,
      initialColumn: "todo",
      moveTask: vi.fn(),
      onSuspend: vi.fn(),
    });

    const result = await boundary.onNodeEntry(nodeIn(ir, "execute"));
    /*
    FNXC:CapacityGateFacts 2026-11-02-21:50 (RUFU-372 second revision): the seam park's own reason code.
    A hold→WIP seam park is scheduler-owned, not a pool refusal, so it no longer borrows `capacity`;
    the `park` identity it carries is unchanged, which is exactly why the durable-park path still fires.
    */
    expect(result).toMatchObject({ kind: "suspended", reason: "scheduler-owned-seam", park: { code: "scheduler-seam", eligible: true } });
    const park = parkOf(result);
    expect(park).not.toHaveProperty("occupants");
    expect(park).not.toHaveProperty("limit");
    // The seam is scheduler-owned and performed no move, so the card still reports its real column.
    expect(boundary.currentColumn()).toBe("todo");
  });

  it("refuses to mark a human-released hold as park-eligible", async () => {
    const ir = holdIr("manual");
    const boundary = createWorkflowColumnBoundary({
      taskId: "FN-PARK4",
      workflowId: "builtin:coding",
      ir,
      initialColumn: "todo",
      moveTask: vi.fn(),
      onSuspend: vi.fn(),
    });

    const result = await boundary.onNodeEntry(nodeIn(ir, "execute"));
    // The suspension itself is unchanged — KTD-2 still parks it — but it is not a capacity wait, so no marker.
    expect(result).toMatchObject({ kind: "suspended", park: { code: "scheduler-seam", eligible: false } });
  });
});
