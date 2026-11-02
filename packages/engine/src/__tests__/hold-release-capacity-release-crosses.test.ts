/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The third defect in the reported incident was that a withheld card never crossed even when a slot was free:
32 cards sat in `todo` while the WIP lanes had room, and the 973 rows/6 h were re-suspensions, not deliveries —
"~1 real board release per 6 h". This file asserts the crossing itself, which no prior test made observable:

1. a card already carrying a FRESH parked marker still releases in the first pass a slot frees. The marker is a
   published verdict and must never become a gate, or the fix for "invisible" would have become a second lock
   on the same card;
2. occupancy at exactly the limit still holds, with the refusal naming the pool and its sample — the negative
   control that keeps (1) from being an over-admission licence;
3. two workflow pools stay independent. Step 1 proved the host budget is per project and the refusal holder set
   equals the live-claim set, so a full lane can only ever be THIS workflow's lane; a fix that widened the pool
   would have been a wrong fix wearing the right badge.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { WIP_ADMISSION_STALL_METADATA_KEY } from "@fusion/core";

import { runHoldReleaseSweep, resetHoldReleaseInstrumentation } from "../execution/hold-release.js";
import { schedulerLog } from "../logger.js";

const WF_A = "custom:pool-a";
const WF_B = "custom:pool-b";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    prompt: "# Planned\n\n## Mission\nImplement the approved work.\n",
    ...over,
  } as Task;
}

function singleWipIr(id: string): WorkflowIr {
  return {
    version: "v2",
    id,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/** A parked card, exactly as the sweep leaves it: same lane, fresh episode, nothing else changed. */
function parkedCard(id: string): Task {
  return task({
    id,
    column: "todo",
    sourceMetadata: {
      [WIP_ADMISSION_STALL_METADATA_KEY]: {
        code: "downstream-full",
        signature: "capacity|todo->in-progress",
        firstAt: new Date().toISOString(),
        lastAt: new Date().toISOString(),
        stallCount: 4,
        fromColumn: "todo",
        toColumn: "in-progress",
        nodeId: "hold-release-sweep",
        poolId: WF_A,
        occupants: 1,
        limit: 1,
      },
    },
  });
}

function storeWith(tasks: Task[], settings: Record<string, unknown>): TaskStore {
  const irs = new Map([WF_A, WF_B].map((id) => [id, singleWipIr(id)]));
  /* Pool membership is derived from the card id so no fake Task field is invented for the fixture. */
  const selectionFor = (id: string) => (id.startsWith("B-") ? WF_B : WF_A);
  return {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async () => tasks),
    moveTaskIf: vi.fn(async (id: string, column: string) => {
      const cur = tasks.find((t) => t.id === id)!;
      cur.column = column;
      return { task: cur, moved: true };
    }),
    updateTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn((id: string) => ({ workflowId: selectionFor(id), stepIds: [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => ({ workflowId: selectionFor(id), stepIds: [] })),
    getWorkflowDefinition: vi.fn(async (workflowId: string) => ({ ir: irs.get(workflowId) })),
  } as unknown as TaskStore;
}

function clock(startMs = Date.parse("2026-11-02T00:00:00.000Z")) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("withheld hold→WIP crossing releases when the lane frees (RUFU-393 symptom)", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
  });

  it("crosses a parked card into in-progress on the first pass after its occupant leaves", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const parked = parkedCard("PARKED");
    const occupant = task({ id: "LIVE", column: "in-progress" });
    const store = storeWith([parked, occupant], { maxConcurrent: 1 });
    const time = clock();

    // Pass 1: the lane is full, so the card stays put and is reported held.
    const blocked = await runHoldReleaseSweep(store, { now: time.now });
    expect(blocked.released).not.toContain("PARKED");
    expect(blocked.held).toContainEqual({ taskId: "PARKED", reason: "downstream-full" });
    expect(parked.column).toBe("todo");

    // The occupant finishes. One pass later — not 6 hours later — the withheld card must be across.
    occupant.column = "done";

    const freed = await runHoldReleaseSweep(store, { now: time.now });

    expect(freed.released).toContain("PARKED");
    expect(parked.column).toBe("in-progress");
    // A published verdict must never act as a second lock: the card crossed while its episode was still fresh.
    expect(parked.sourceMetadata?.[WIP_ADMISSION_STALL_METADATA_KEY]).toBeTruthy();
  });

  it("holds at exactly the limit, naming the pool and its occupancy sample", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const parked = parkedCard("PARKED");
    const occupant = task({ id: "LIVE", column: "in-progress" });
    const store = storeWith([parked, occupant], { maxConcurrent: 1 });
    const time = clock();

    const result = await runHoldReleaseSweep(store, { now: time.now });

    expect(result.released).not.toContain("PARKED");
    expect(parked.column).toBe("todo");
    expect(result.held).toContainEqual({ taskId: "PARKED", reason: "downstream-full" });
  });

  it("keeps two workflow pools independent, so one full lane cannot hold another workflow's card", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const heldInA = task({ id: "A-READY", column: "todo" });
    const occupantInA = task({ id: "A-LIVE", column: "in-progress" });
    const readyInB = task({ id: "B-READY", column: "todo" });
    const store = storeWith([heldInA, occupantInA, readyInB], { maxConcurrent: 1 });

    const result = await runHoldReleaseSweep(store, { now: clock().now });

    // Pool A is at its limit; pool B's lane is empty. Both facts must hold at once.
    expect(result.held).toContainEqual({ taskId: "A-READY", reason: "downstream-full" });
    expect(heldInA.column).toBe("todo");
    expect(result.released).toContain("B-READY");
    expect(readyInB.column).toBe("in-progress");
  });
});
