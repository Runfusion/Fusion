/*
FNXC:CapacitySuspendDeferral 2026-10-15-08:25 (RUFU-616):
RUFU-442 bounded how often a capacity wait is RESTATED and deliberately left the wait itself alone, so
the suspended continuation stayed DUE on every scheduler pass. Each pass re-claimed the row, ran the
graph to the same capacity refusal, and left a fresh `running` claim behind — the occupancy of the
previous pass was part of what made the next pass refuse capacity, so the wait manufactured its own
cause (measured 2026-10-15: one card re-dispatched until the reclaim sweep emitted 16,787 `dead-lease`
requeues). The executor now DEFERS the row — a future `retryAfter` written through the same-state CAS
the reclaim sweep already uses — and these cases pin that at the production seam
(`TaskExecutor.executeWorkflowGraph`), never at source text: the deferral is written, it widens, it is
scoped to `reason === "capacity"`, and it never relocates the card.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import type { TaskDetail, WorkflowIr, WorkflowWorkItem, WorkflowWorkItemTransitionPatch } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { WorkflowGraphTaskRunner } from "../workflows/workflow-graph-task-runner.js";
import { resetWorkflowRunSuspendedNoticeState } from "../executor/run-suspended-notice.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

/**
 * FNXC:CapacitySuspendDeferral 2026-10-15-08:25 (RUFU-616):
 * Only `Date` is faked, never the timer functions: the bounded run-audit emit arms a real timeout it
 * clears on settle, and pinning the clock (rather than advancing it) is what lets every produced
 * `retryAfter` be asserted EXACTLY instead of inside a tolerance band. No case waits on anything.
 */
const CLOCK_FIXED_MS = Date.parse("2026-10-15T08:00:00.000Z");

/** Deferral ceiling the ladder must never exceed (the last rung). */
const MAX_DEFERRAL_MS = 15 * 60_000;

/*
FNXC:CapacitySuspendDeferral 2026-10-15-08:25 (RUFU-616):
A production capacity refusal is the hold→wip boundary verdict: the IR's `todo` column releases on
capacity, so entering a `wip` node is a wait, not a move. The IR stays that shape so the fixture's
suspension is the one the seam really receives.
*/
const CAPACITY_IR = {
  version: "v2",
  name: "capacity-deferral",
  columns: [
    { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", name: "In-progress", traits: [{ trait: "wip" }, { trait: "timing" }] },
    { id: "in-review", name: "In-review", traits: [{ trait: "human-review" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "todo" },
    { id: "execute", kind: "prompt", column: "in-progress" },
    { id: "review", kind: "prompt", column: "in-review" },
  ],
  edges: [
    { from: "start", to: "execute" },
    { from: "execute", to: "review", condition: "success" },
  ],
} as unknown as WorkflowIr;

/** The wait the scheduler re-dispatches: the card sits in the hold column, the node lives in wip. */
function capacitySuspension() {
  return {
    kind: "suspended",
    reason: "capacity",
    nodeId: "execute",
    fromColumn: "todo",
    toColumn: "in-progress",
    irHash: "ir-hash",
  };
}

/** The same seam refusing for a reason with an external releaser (unpause clears the row on wake). */
function pauseSuspension() {
  return {
    kind: "suspended",
    reason: "pause",
    nodeId: "execute",
    fromColumn: "todo",
    toColumn: "in-progress",
    irHash: "ir-hash",
  };
}

/** A continuation row as the scheduler hands it over: already `running` — that claim is the churn. */
function continuationRow(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  const stampedAt = new Date(CLOCK_FIXED_MS - 10_000).toISOString();
  return {
    id: "wi-capacity",
    runId: "RUFU-616:wf-capacity",
    taskId: "RUFU-616",
    nodeId: "execute",
    kind: "task",
    state: "running",
    attempt: 0,
    retryAfter: null,
    leaseOwner: "executor:RUFU-616",
    leaseExpiresAt: null,
    lastError: null,
    blockedReason: null,
    createdAt: stampedAt,
    updatedAt: stampedAt,
    ...overrides,
  } as WorkflowWorkItem;
}

interface Harness {
  store: any;
  task: TaskDetail;
  executor: any;
  /** Every `transitionWorkflowWorkItem` call, in call order, for the whole test. */
  transitions: Array<{ id: string; state: string; patch: WorkflowWorkItemTransitionPatch }>;
  /** Read the durable row back the way the next scheduler pass would see it. */
  currentRow: () => WorkflowWorkItem;
}

/**
 * FNXC:CapacitySuspendDeferral 2026-10-15-08:25 (RUFU-616):
 * One fake row store with real CAS semantics (`expectedState` mismatch is a no-op returning the live
 * row) and write-through `retryAfter`/`updatedAt`, so a SECOND graph pass reads the row the FIRST pass
 * deferred. That is what lets the ladder be driven through the real loop instead of by exporting its
 * internals: the row's own previous width is the only input the ladder has.
 */
function wiredHarness(row: WorkflowWorkItem = continuationRow()): Harness {
  const task = {
    id: row.taskId,
    title: "capacity deferral",
    description: "capacity deferral",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as unknown as TaskDetail;

  const store = createMockStore();
  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({ experimentalFeatures: { workflowGraphExecutor: true } });
  store.getTaskWorkflowSelectionAsync = vi.fn(async () => ({ workflowId: "wf-capacity", stepIds: [] }));
  store.getWorkflowDefinition = vi.fn(async () => ({ id: "wf-capacity", ir: CAPACITY_IR }));
  store.recordRunAuditEvent = vi.fn(async () => undefined);

  const rows = new Map<string, WorkflowWorkItem>([[row.id, row]]);
  const transitions: Harness["transitions"] = [];
  store.listWorkflowWorkItemsForTask = vi.fn(async () => [...rows.values()]);
  store.transitionWorkflowWorkItem = vi.fn(async (
    id: string,
    state: WorkflowWorkItem["state"],
    patch: WorkflowWorkItemTransitionPatch = {},
  ) => {
    const current = rows.get(id)!;
    if (patch.expectedState !== undefined && patch.expectedState !== current.state) return current;
    transitions.push({ id, state, patch });
    const next: WorkflowWorkItem = {
      ...current,
      state,
      ...(patch.retryAfter !== undefined ? { retryAfter: patch.retryAfter } : {}),
      updatedAt: new Date().toISOString(),
    };
    rows.set(id, next);
    return next;
  });

  return {
    store,
    task,
    executor: new TaskExecutor(store, "/repo") as any,
    transitions,
    currentRow: () => rows.get(row.id)!,
  };
}

/** One scheduler pass: the graph reaches the capacity seam and returns the wait. */
async function driveSuspendedPass(harness: Harness, suspension: ReturnType<typeof capacitySuspension>) {
  const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockResolvedValue({
    disposition: "suspended",
    outcome: "failure",
    visitedNodeIds: [],
    suspension,
  } as any);
  try {
    await harness.executor.executeWorkflowGraph(harness.task);
  } finally {
    run.mockRestore();
  }
}

/** Width of the deferral the pass just wrote, measured from the pinned clock. */
function deferredWidthMs(patch: WorkflowWorkItemTransitionPatch | undefined): number {
  expect(patch?.retryAfter).toEqual(expect.any(String));
  return Date.parse(patch!.retryAfter as string) - CLOCK_FIXED_MS;
}

function suspensionAuditCalls(store: any) {
  return store.recordRunAuditEvent.mock.calls
    .map(([event]: [any]) => event)
    .filter((event: any) => event.mutationType === "task:workflow-run-suspended");
}

beforeEach(() => {
  resetExecutorMocks();
  /*
  FNXC:CapacitySuspendDeferral 2026-10-15-08:25 (RUFU-616):
  The restatement bound is per-process memory. Each case below is an independent scenario, so the
  remembered wait is dropped between them — otherwise the first case's wait would suppress a later
  case's audit row and the assertion would be testing the harness, not the engine.
  */
  resetWorkflowRunSuspendedNoticeState();
  vi.useFakeTimers({ now: CLOCK_FIXED_MS, toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("capacity-suspended continuation deferral (RUFU-616)", () => {
  it("defers the wait with a future retryAfter written by a same-state transition", async () => {
    const harness = wiredHarness();

    await driveSuspendedPass(harness, capacitySuspension());

    // One write, and it is the deferral: the row entered `running`, so nothing had to claim it first.
    expect(harness.transitions).toHaveLength(1);
    const [deferral] = harness.transitions;
    expect(deferral.id).toBe("wi-capacity");
    // Same-state CAS: the transition targets the row's own state and guards on it, so a fresher
    // writer cannot be clobbered and no state is invented.
    expect(deferral.state).toBe("running");
    expect(deferral.patch.expectedState).toBe("running");
    expect(Date.parse(deferral.patch.retryAfter as string)).toBeGreaterThan(CLOCK_FIXED_MS);

    const row = harness.currentRow();
    expect(row.state).toBe("running");
    expect(row.retryAfter).toBe(deferral.patch.retryAfter);
  });

  it("widens the deferral through the ladder on every repeated pass and never exceeds the cap", async () => {
    const harness = wiredHarness();

    // Driven through the real loop: each pass reads the row the previous pass deferred, so the
    // observed widths are the ladder's own output rather than a copy of its constant.
    const widths: number[] = [];
    for (let pass = 0; pass < 5; pass += 1) {
      const before = harness.transitions.length;
      await driveSuspendedPass(harness, capacitySuspension());
      expect(harness.transitions).toHaveLength(before + 1);
      widths.push(deferredWidthMs(harness.transitions[before]?.patch));
    }

    expect(widths).toEqual([60_000, 2 * 60_000, 5 * 60_000, MAX_DEFERRAL_MS, MAX_DEFERRAL_MS]);
    // The cap is the invariant: a card whose capacity never frees keeps probing at the widest rung
    // rather than vanishing from the due poll forever.
    expect(Math.max(...widths)).toBeLessThanOrEqual(MAX_DEFERRAL_MS);
  });

  it("starts from the rung already worn by a prior deferral instead of restarting the ladder", async () => {
    const harness = wiredHarness(continuationRow({
      updatedAt: new Date(CLOCK_FIXED_MS - 60_000).toISOString(),
      retryAfter: new Date(CLOCK_FIXED_MS).toISOString(),
    }));

    await driveSuspendedPass(harness, capacitySuspension());

    expect(harness.transitions).toHaveLength(1);
    expect(deferredWidthMs(harness.transitions[0].patch)).toBe(2 * 60_000);
  });

  it("writes no retryAfter for a non-capacity wait, which has an external releaser", async () => {
    const harness = wiredHarness();

    await driveSuspendedPass(harness, pauseSuspension());

    // No deferral at all: hiding a pause behind a timer would strand it, because unpausing — not the
    // clock — is what releases it.
    expect(harness.transitions.filter((entry) => entry.patch.retryAfter !== undefined)).toHaveLength(0);
    expect(harness.currentRow().retryAfter).toBeNull();
    // Negative control: the wait is still processed and reported, so this case proves the deferral is
    // scoped to capacity rather than the suspension branch having stopped working.
    expect(suspensionAuditCalls(harness.store)).toHaveLength(1);
  });

  it("never moves the card's column for a capacity suspension", async () => {
    const harness = wiredHarness();

    await driveSuspendedPass(harness, capacitySuspension());

    // Lifecycle containment: a capacity verdict may slow a card down, never relocate it.
    expect(harness.store.moveTask).not.toHaveBeenCalled();
    expect(harness.store.moveTaskIf).not.toHaveBeenCalled();
    expect(harness.store.handoffToReview).not.toHaveBeenCalled();
    expect((await harness.store.getTask(harness.task.id)).column).toBe("todo");
  });

  it("still defers on a pass whose audit restatement was already bounded", async () => {
    const harness = wiredHarness();

    await driveSuspendedPass(harness, capacitySuspension());
    await driveSuspendedPass(harness, capacitySuspension());

    // RUFU-442's bound suppresses the RESTATEMENT only; the deferral must keep widening every pass,
    // so it is written before the `isNewWait` early return rather than after it.
    expect(suspensionAuditCalls(harness.store)).toHaveLength(1);
    expect(harness.transitions).toHaveLength(2);
    expect(deferredWidthMs(harness.transitions[1].patch)).toBe(2 * 60_000);
  });
});
