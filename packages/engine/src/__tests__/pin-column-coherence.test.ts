/*
FNXC:ResumePlacement 2026-11-01-17:55 (RUFU-300):
Pin/column coherence must never be SILENT — and must never be a false alarm.

The pin triple (`workflowIrPin` / `workflowIrPinNodeId` / `workflowIrPinColumnId`) is written by the
column boundary AT node entry, i.e. BEFORE the KTD-2 hold→wip refusal, so `pin column = "in-progress"`
while `task.column = "todo"` is the DESIGNED signature of a card parked at the scheduler's release
seam. Classifying that as incoherence would make every capacity-bound card announce forever; leaving a
genuine disagreement silent is the state RUFU-292 sat in for 6h33m. The fixed `mismatchKind` enum is
what separates the two.
*/
import { describe, expect, it, vi } from "vitest";
import "@fusion/core";
import {
  getBuiltinWorkflow,
  parseWorkflowIr,
  computeWorkflowIrPin,
  planTaskColumnRestart,
  type TaskDetail,
  type TaskStore,
} from "@fusion/core";

const { recordRunAuditEventMock } = vi.hoisted(() => ({
  recordRunAuditEventMock: vi.fn(async () => undefined),
}));

import { SelfHealingManager } from "../self-healing.js";

import {
  resolveResumePlacement,
  announceResumePlacement,
  resetResumePlacementEpisodeForTesting,
  type ResumePlacementSinks,
} from "../workflows/resume-placement.js";

const codingIr = parseWorkflowIr(getBuiltinWorkflow("builtin:coding")!.ir as never);

function task(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "RUFU-300-D",
    title: "pin/column coherence",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workflowStepResults: [],
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...over,
  } as unknown as TaskDetail;
}

/** RUFU-292's recorded pin/column pair: pin names the execution lane, card still in planning. */
function seamParked(over: Partial<TaskDetail> = {}): TaskDetail {
  return task({
    enabledWorkflowSteps: ["plan-review", "code-review", "post-merge-verification"],
    workflowStepResults: [{
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "passed",
      verdict: "APPROVE_WITH_NOTES",
      completedAt: "2026-09-24T14:41:36.612Z",
    }],
    workflowIrPin: computeWorkflowIrPin(codingIr, "parse").irHash,
    workflowIrPinNodeId: "parse",
    workflowIrPinColumnId: "in-progress",
    ...over,
  });
}

function recorders(): { sinks: ResumePlacementSinks; logs: string[]; audits: Array<Record<string, unknown>> } {
  const logs: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  return {
    logs,
    audits,
    sinks: {
      logEntry: async (_id: string, message: string) => { logs.push(message); },
      emitAudit: (event: Record<string, unknown>) => { audits.push(event); },
    },
  };
}

describe("RUFU-300 (d) — pin/column disagreement is classified, never silent, never a false alarm", () => {
  it("classifies a legal ready-for-release seam park as `pin-at-release-seam`, not as incoherence", () => {
    const placement = resolveResumePlacement({ ir: codingIr, task: seamParked() });

    expect(placement.nodeId).toBe("parse");
    expect(placement.source).toBe("after-released-gate");
    expect(placement.releasedNodeIds).toContain("plan-review");
    expect(placement.mismatch?.kind).toBe("pin-at-release-seam");
  });

  it("classifies a pin naming a lane ahead with no live release reason as `pin-ahead-of-column`", () => {
    // `in-review` is a review lane, not the wip lane a hold→wip seam would name.
    const placement = resolveResumePlacement({
      ir: codingIr,
      task: seamParked({ workflowIrPinColumnId: "in-review", workflowIrPinNodeId: "browser-verification" }),
    });

    expect(placement.mismatch?.kind).toBe("pin-ahead-of-column");
    expect(placement.mismatch?.pinColumnId).toBe("in-review");
    expect(placement.mismatch?.columnId).toBe("todo");
  });

  it("classifies a pin left behind by a forward move as `pin-behind-column`", () => {
    const placement = resolveResumePlacement({
      ir: codingIr,
      task: task({ column: "in-review", workflowIrPinColumnId: "todo", workflowIrPinNodeId: "plan-review" }),
    });

    expect(placement.mismatch?.kind).toBe("pin-behind-column");
  });

  it("reports no mismatch for a card with no pin, and no placement without gate or pin evidence", () => {
    const plain = resolveResumePlacement({ ir: codingIr, task: task() });
    expect(plain.mismatch).toBeUndefined();
    expect(plain.source).toBe("column");
    expect(plain.nodeId).toBe("start");
  });

  it("announces a genuine incoherence exactly once per episode, with ids/enums only", async () => {
    resetResumePlacementEpisodeForTesting();
    const { sinks, logs, audits } = recorders();
    const incoherent = seamParked({ workflowIrPinColumnId: "in-review", workflowIrPinNodeId: "browser-verification" });
    const placement = resolveResumePlacement({ ir: codingIr, task: incoherent });

    await announceResumePlacement(sinks, { taskId: incoherent.id, ir: codingIr, task: incoherent, placement });
    await announceResumePlacement(sinks, { taskId: incoherent.id, ir: codingIr, task: incoherent, placement });
    await announceResumePlacement(sinks, { taskId: incoherent.id, ir: codingIr, task: incoherent, placement });

    /*
     * FNXC:ResumePlacement 2026-11-01-21:40 (RUFU-300): the announcement seam now carries two orthogonal
     * facts — the coherence verdict and the released-gate skip — so "exactly once" is counted on the
     * notice this leg is about rather than on every line the seam can write.
     */
    const coherence = logs.filter((line) => line.includes("resume placed at"));
    expect(coherence).toHaveLength(1);
    expect(coherence[0]).toContain("[workflow-graph]");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      mutationType: "task:resume-placement-mismatch",
      mismatchKind: "pin-ahead-of-column",
      column: "todo",
      workflowIrPinColumnId: "in-review",
      workflowIrPinNodeId: "browser-verification",
      placementSource: "after-released-gate",
    });
    // ids/enums only: no metadata value may carry step-result content or prose.
    for (const value of Object.values(audits[0]!)) {
      expect(typeof value === "string" ? value.length <= 80 : true).toBe(true);
    }
  });

  it("announces a legal seam park as a bounded churn notice, never as an incoherence finding", async () => {
    resetResumePlacementEpisodeForTesting();
    const { sinks, logs, audits } = recorders();
    const parked = seamParked();
    const placement = resolveResumePlacement({ ir: codingIr, task: parked });

    for (let pass = 0; pass < 4; pass += 1) {
      await announceResumePlacement(sinks, { taskId: parked.id, ir: codingIr, task: parked, placement });
    }

    expect(logs.filter((line) => line.includes("resume placed at"))).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ mismatchKind: "pin-at-release-seam", outcome: "awaiting-scheduler-release" });
    // The incoherence vocabulary must not fire for a legal park.
    expect(audits[0]!.mismatchKind).not.toBe("pin-ahead-of-column");
    expect(audits[0]!.mismatchKind).not.toBe("pin-behind-column");
  });

  it("a hostile, rejecting, or absent sink cannot change the placement", async () => {
    resetResumePlacementEpisodeForTesting();
    const parked = seamParked();
    const placement = resolveResumePlacement({ ir: codingIr, task: parked });

    const hostile: ResumePlacementSinks = {
      logEntry: () => { throw new Error("log sink exploded"); },
      emitAudit: () => { throw new Error("audit sink exploded"); },
    };
    // A hostile sink that throws synchronously must not reject the promise or change placement. The
    // announce seam returns whether it wrote the coherence notice; the invariant is that exploding
    // sinks never surface an error and never alter the placement computed below.
    await expect(announceResumePlacement(hostile, { taskId: "HOSTILE", ir: codingIr, task: parked, placement }))
      .resolves.toEqual({ mismatchAnnounced: true });

    const rejecting: ResumePlacementSinks = {
      logEntry: async () => { throw new Error("rejected"); },
      emitAudit: async () => { throw new Error("rejected"); },
    };
    await expect(announceResumePlacement(rejecting, { taskId: "REJECTING", ir: codingIr, task: parked, placement }))
      .resolves.toEqual({ mismatchAnnounced: true });

    // No sinks wired: nothing to announce, so the episode is not consumed and no notice is written.
    await expect(announceResumePlacement({}, { taskId: "NO-SINKS", ir: codingIr, task: parked, placement }))
      .resolves.toEqual({ mismatchAnnounced: false });

    // The placement itself is untouched by any of them.
    expect(resolveResumePlacement({ ir: codingIr, task: parked })).toMatchObject({ nodeId: "parse", source: "after-released-gate" });
  });

  it("clears the episode when the pin and column become coherent, so a new wedge can announce", async () => {
    resetResumePlacementEpisodeForTesting();
    const { sinks, audits } = recorders();
    const incoherent = seamParked({ workflowIrPinColumnId: "in-review", workflowIrPinNodeId: "browser-verification" });
    await announceResumePlacement(sinks, { taskId: "EPISODE", ir: codingIr, task: incoherent, placement: resolveResumePlacement({ ir: codingIr, task: incoherent }) });
    expect(audits).toHaveLength(1);

    // The scheduler releases the card; its column now matches its pin.
    const coherent = seamParked({ column: "in-progress" });
    await announceResumePlacement(sinks, { taskId: "EPISODE", ir: codingIr, task: coherent, placement: resolveResumePlacement({ ir: codingIr, task: coherent }) });
    expect(audits).toHaveLength(1);

    // A NEW wedge after coherence is a new episode and must announce again.
    const rewedged = seamParked({ column: "in-progress", workflowIrPinColumnId: "done", workflowIrPinNodeId: "merge" });
    await announceResumePlacement(sinks, { taskId: "EPISODE", ir: codingIr, task: rewedged, placement: resolveResumePlacement({ ir: codingIr, task: rewedged }) });
    expect(audits).toHaveLength(2);
  });
});

describe("RUFU-300 (e) — human decisions are unchanged", () => {
  it("an operator column Restart still clears the pin triple deliberately", () => {
    const target = task({
      column: "in-progress",
      workflowIrPin: computeWorkflowIrPin(codingIr, "parse").irHash,
      workflowIrPinNodeId: "parse",
      workflowIrPinColumnId: "in-progress",
      workflowStepResults: [{ workflowStepId: "code-review", workflowStepName: "Code Review", status: "failed", completedAt: "2026-09-24T15:00:00.000Z" }],
    });

    const plan = planTaskColumnRestart({
      task: target,
      ir: codingIr,
      entryNode: { id: "parse", column: "in-progress" },
    } as never);

    expect(plan.kind).toBe("restart");
    // The deliberate human reset: the pin triple goes away in the same patch.
    expect((plan as { patch: Record<string, unknown> }).patch.workflowIrPin).toBeNull();
    expect((plan as { patch: Record<string, unknown> }).patch.workflowIrPinNodeId).toBeNull();
    expect((plan as { patch: Record<string, unknown> }).patch.workflowIrPinColumnId).toBeNull();
  });

  it("a wiped ledger with a cleared pin resolves from the column contract, with no mismatch", () => {
    const afterRestart = task({ column: "in-progress" });
    const placement = resolveResumePlacement({ ir: codingIr, task: afterRestart });
    expect(placement.source).toBe("column");
    expect(placement.nodeId).toBe("parse");
    expect(placement.mismatch).toBeUndefined();
    expect(vi.isMockFunction(() => undefined)).toBe(false);
  });
});

/*
FNXC:ResumePlacement 2026-11-01-19:10 (RUFU-300 Step 4, finding F-03):
The dispatch seam announces a disagreement only for cards something actually dispatches. F-03's gap was
the other population — a parked, dependency-blocked, or finished card whose pin names a lane it is not
in, which had no reader at all. These legs drive the report sweep that closes it, through the real
`SelfHealingManager`, so the sweep cannot be a second classifier with its own opinion: it must produce
the SAME enum the dispatch seam produces for the SAME card.
*/

function coherenceStore(cards: TaskDetail[]) {
  const rows = new Map(cards.map((card) => [card.id, card]));
  const logged: Array<{ id: string; message: string }> = [];
  recordRunAuditEventMock.mockClear();
  const store = {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async () => [...rows.values()]),
    getTask: vi.fn(async (id: string) => rows.get(id)),
    logEntry: vi.fn(async (id: string, message: string) => { logged.push({ id, message }); }),
    getRootDir: vi.fn(() => "coherence-project"),
    /*
     * FNXC:ResumePlacement 2026-11-01-19:12 (RUFU-300): the sweep emits through the bounded FN-9175 seam,
     * whose sink is `store.recordRunAuditEvent` — so the assertion sits on the real sink the seam calls,
     * not on a mocked module. A mocked audit layer cannot prove a bounded emit actually reached a sink.
     */
    recordRunAuditEvent: recordRunAuditEventMock,
  } as unknown as TaskStore;
  return { store, logged, rows };
}

describe("RUFU-300 (d-2) — a disagreement on a card nobody dispatches is still reported", () => {
  it("names a genuine incoherence once, with the sweep as its source, and never re-announces it", async () => {
    resetResumePlacementEpisodeForTesting();
    recordRunAuditEventMock.mockClear();
    const stale = task({
      id: "RUFU-300-IDLE",
      column: "todo",
      workflowIrPin: computeWorkflowIrPin(codingIr, "browser-verification").irHash,
      workflowIrPinNodeId: "browser-verification",
      workflowIrPinColumnId: "in-review",
    });
    const { store, logged } = coherenceStore([stale]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", getExecutingTaskIds: () => new Set<string>() });

    expect(await manager.reconcilePinColumnCoherence()).toBe(1);
    expect(logged.filter((entry) => entry.message.includes("resume placed at"))).toHaveLength(1);
    expect(await manager.reconcilePinColumnCoherence()).toBe(0);
    expect(await manager.reconcilePinColumnCoherence()).toBe(0);
    expect(logged.filter((entry) => entry.message.includes("resume placed at"))).toHaveLength(1);

    const row = recordRunAuditEventMock.mock.calls
      .map((call) => call[0] as { mutationType?: string; metadata?: Record<string, unknown> })
      .find((call) => call.mutationType === "task:resume-placement-mismatch");
    expect(row?.metadata).toMatchObject({
      taskId: "RUFU-300-IDLE",
      mismatchKind: "pin-ahead-of-column",
      outcome: "announced",
      source: "coherence-sweep",
    });
    // ids and fixed enums only: no metadata value carries prose longer than an id/enum can be.
    for (const value of Object.values(row?.metadata ?? {})) {
      expect(typeof value === "string" ? value.length <= 80 : true).toBe(true);
    }
  });

  it("reports the legal seam park under its own enum, so a capacity wait is never an incoherence alarm", async () => {
    resetResumePlacementEpisodeForTesting();
    recordRunAuditEventMock.mockClear();
    const parked = task({
      ...seamParked(),
      id: "RUFU-300-SEAM",
      enabledWorkflowSteps: ["plan-review", "code-review", "post-merge-verification"],
      workflowStepResults: [{
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        status: "passed",
        verdict: "APPROVE_WITH_NOTES",
        completedAt: "2026-09-24T14:41:36.612Z",
      }],
      workflowIrPin: computeWorkflowIrPin(codingIr, "parse").irHash,
      workflowIrPinNodeId: "parse",
      workflowIrPinColumnId: "in-progress",
    });
    const { store } = coherenceStore([parked]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", getExecutingTaskIds: () => new Set<string>() });

    await manager.reconcilePinColumnCoherence();
    const row = recordRunAuditEventMock.mock.calls
      .map((call) => call[0] as { metadata?: Record<string, unknown> })
      .map((call) => call.metadata)
      .find((metadata) => metadata?.taskId === "RUFU-300-SEAM");
    expect(row).toMatchObject({ mismatchKind: "pin-at-release-seam", outcome: "awaiting-scheduler-release" });
    expect(row!.mismatchKind).not.toBe("pin-ahead-of-column");
    expect(row!.mismatchKind).not.toBe("pin-behind-column");
  });

  it("says nothing about a coherent card, a half-null pin, or a card a live owner is driving", async () => {
    resetResumePlacementEpisodeForTesting();
    recordRunAuditEventMock.mockClear();
    const coherent = task({
      id: "RUFU-300-COHERENT",
      column: "in-progress",
      workflowIrPin: computeWorkflowIrPin(codingIr, "parse").irHash,
      workflowIrPinNodeId: "parse",
      workflowIrPinColumnId: "in-progress",
    });
    const halfNull = task({ id: "RUFU-300-HALF", column: "todo", workflowIrPinNodeId: "parse" });
    const operatorHeld = task({
      id: "RUFU-300-HELD",
      column: "todo",
      userPaused: true,
      workflowIrPin: computeWorkflowIrPin(codingIr, "browser-verification").irHash,
      workflowIrPinNodeId: "browser-verification",
      workflowIrPinColumnId: "in-review",
    });
    const liveRun = task({
      id: "RUFU-300-LIVE",
      column: "todo",
      workflowIrPin: computeWorkflowIrPin(codingIr, "browser-verification").irHash,
      workflowIrPinNodeId: "browser-verification",
      workflowIrPinColumnId: "in-review",
    });
    const { store, logged } = coherenceStore([coherent, halfNull, operatorHeld, liveRun]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", getExecutingTaskIds: () => new Set(["RUFU-300-LIVE"]) });

    expect(await manager.reconcilePinColumnCoherence()).toBe(0);
    expect(logged).toEqual([]);
    expect(recordRunAuditEventMock.mock.calls
      .map((call) => call[0] as { mutationType?: string })
      .filter((call) => call.mutationType === "task:resume-placement-mismatch")).toEqual([]);
  });
});
