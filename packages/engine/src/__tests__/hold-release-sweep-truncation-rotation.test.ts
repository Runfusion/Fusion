/*
FNXC:HoldReleaseTruncationRotation 2026-10-16-22:35 (RUFU-698 Step 3):
Field evidence: `Hold-release sweep: project=proj_9326d74a133b421a: 30038ms (… evaluate 27126ms over
642 tasks (…)), released=0, held=3, budget-truncated unevaluated=444, budgetOverrunMs=20038` — the same
`unevaluated=444` on EVERY pass. A truncated pass stops at `breakIndex` and the next pass re-sorts the
SAME list into the SAME order (`sortTasksByQueueOrder` is deterministic), so the cards behind the break
are re-skipped forever while `capacity_refused=0` says the pool is not full. The fix hands the deferred
tail their turn first.

These tests pin the fairness contract, not the perf:
 - the tail a truncated pass never reached is evaluated FIRST on the next pass (`rotated-deferred`);
 - a pass that finishes inside its budget ends the inversion, so the pass after it runs in plain queue
   order — the priority inversion is bounded to one pass, by construction;
 - a deferred id that left the board shifts nothing but its own absence.
Two fixture decisions make this deterministic rather than timing-dependent:
 - the cards sit in a `release: "manual"` hold column, so no card is ever released or moved and
   `result.held` — pushed in evaluation order — IS the evaluation order, asserted on the result object;
 - the deadline is blown inside the first workflow-definition read (the technique
   `hold-release-sweep-bounded-db-work.test.ts` uses), so exactly the card that triggered the read is
   evaluated and every card behind it is the deferred tail.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { resetHoldReleaseInstrumentation, runHoldReleaseSweep } from "../execution/hold-release.js";
import { schedulerLog } from "../logger.js";

const WF = "custom:rotate-wf";
/*
Rotation state is keyed by SWEEP PROJECT, not by store object (a central deployment holds several store
instances for one project's rows). Every fixture store here must therefore report the same project id,
or each pass would rotate a different project's tail and the test would observe nothing.
*/
const PROJECT_ID = "proj-rotation-test";

function task(id: string): Task {
  return {
    id,
    title: id,
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
    /*
    A card released into processing must pass the plan-premise gate (RUFU-145 / RUFU-246) and this
    store exposes no `getTasksDir`, so the gate reads `task.prompt`. The manual-hold column below never
    reaches that gate, but the field keeps the fixture honest for any future release-path assertion.
    */
    prompt: "# Planned\n\n## Mission\nImplement the approved work.\n",
  } as Task;
}

/** `release: "manual"` holds every card in place, so evaluation order stays observable pass after pass. */
function manualHoldIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "manual" } }] },
      { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/** A capacity hold with room to spare, so a refusal here is never a shortage. */
function capacityIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limit: 10 } }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/**
 * `blowDeadlineOnFirstDefinitionRead` advances the shared clock past the sweep budget during the first
 * definition read, which lands inside candidate 0's evaluation: candidate 0 completes, the next
 * top-of-loop deadline check truncates, and everything behind candidate 0 becomes the deferred tail.
 */
function storeWith(
  tasks: Task[],
  clock: { t: number },
  opts: { blowDeadline?: boolean; ir?: WorkflowIr } = {},
): TaskStore {
  const selection = { workflowId: WF, stepIds: [] };
  let reads = 0;
  return {
    getWorkflowSettingsProjectId: () => PROJECT_ID,
    getSettings: vi.fn(async () => ({ maxConcurrent: 4 })),
    listTasks: vi.fn(async () => tasks),
    moveTaskIf: vi.fn(async (id: string, column: string) => {
      const cur = tasks.find((t) => t.id === id)!;
      cur.column = column;
      return { task: cur, moved: true };
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => {
      reads += 1;
      if (opts.blowDeadline && reads === 1) clock.t += 11;
      return { ir: opts.ir ?? manualHoldIr() };
    }),
  } as unknown as TaskStore;
}

/** `held` is appended in evaluation order, so its ids are the order the sweep actually walked. */
const heldOrder = (result: { held: { taskId: string }[] }): string[] => result.held.map((entry) => entry.taskId);

describe("hold-release sweep truncation rotation (RUFU-698)", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
  });

  it("evaluates the tail a truncated pass never reached first on the next pass", async () => {
    const debug = vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
    // Equal createdAt everywhere → `sortTasksByQueueOrder` falls through to id, so A,B,C,D is plain queue order.
    const tasks = [task("R-A"), task("R-B"), task("R-C"), task("R-D")];
    const clock = { t: 1_000 };
    const deps = { now: () => clock.t };

    // Pass 1: the deadline dies inside R-A's definition read, so B/C/D are the deferred tail.
    const first = await runHoldReleaseSweep(storeWith(tasks, clock, { blowDeadline: true }), { ...deps, budgetMs: 10 });
    expect(first.budgetTruncated).toBe(true);
    expect(first.unevaluatedCount).toBe(3);
    expect(heldOrder(first)).toEqual(["R-A"]);
    expect(first.rotatedDeferredCount).toBeUndefined();

    // Pass 2: the deferred tail competes first, and R-A goes back to the end it should have had.
    const second = await runHoldReleaseSweep(storeWith(tasks, clock), deps);
    expect(second.budgetTruncated).toBeUndefined();
    expect(second.rotatedDeferredCount).toBe(3);
    expect(heldOrder(second)).toEqual(["R-B", "R-C", "R-D", "R-A"]);

    const line = [...warn.mock.calls, ...debug.mock.calls]
      .map((call) => String(call[0]))
      .find((l) => l.includes("rotated-deferred=3"));
    expect(line).toBeDefined();

    /*
    Pass 3: pass 2 finished inside its budget, which DELETES the recorded tail — the priority
    inversion is bounded to one pass and cannot become a permanent starvation of the queue head.
    */
    const third = await runHoldReleaseSweep(storeWith(tasks, clock), deps);
    expect(third.rotatedDeferredCount).toBeUndefined();
    expect(heldOrder(third)).toEqual(["R-A", "R-B", "R-C", "R-D"]);
  });

  /*
  FNXC:HoldReleaseTruncationRotation 2026-10-16-21:00 (RUFU-698 Step 4 — symptom verification):
  ORIGINAL SYMPTOM: `Hold-release sweep … 30038ms … released=0, held=3, budget-truncated
  unevaluated=444` on EVERY pass of a 642-task project, with `capacity_refused=0`, i.e. capacity was
  free and the same 444 cards were never examined twice.

  EXACT REPRODUCTION: a capacity-releasable board whose reservation leg spends the sweep budget, a
  queue head whose admission is refused, and a tail behind the break. The fake clock advances inside
  `reserveSlot` (25 ms per call, 60 ms budget), which is what the field sweep measured at seconds per
  call, so truncation is deterministic rather than timing-dependent.

  ASSERTION IT IS GONE: the shape `truncated AND released nothing` may appear once, but it must not
  survive a second pass while capacity is free — the deferred tail is served first and releases.
  */
  it("releases the starved tail on the next pass while capacity is free", async () => {
    const warn = vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
    const clock = { t: 1_000 };
    const tasks: Task[] = [];
    for (let index = 0; index < 60; index += 1) tasks.push(task(`FILL-${String(index).padStart(3, "0")}`));
    for (let index = 1; index <= 12; index += 1) tasks.push(task(`C-${String(index).padStart(2, "0")}`));
    for (const filler of tasks) filler.column = filler.id.startsWith("C-") ? "todo" : "done";
    const store = storeWith(tasks, clock, { ir: capacityIr() });

    /*
    The first three cards lose admission (the field case: a higher-priority lifecycle lane took the
    slot), and each attempt spends 25 ms of a 60 ms budget — the leg is what exhausts it, not the count.
    */
    const refusedHeadIds = new Set(["C-01", "C-02", "C-03"]);
    const reserveSlot = async (candidate: Task) => {
      clock.t += 25;
      return refusedHeadIds.has(candidate.id) ? null : { release: () => undefined };
    };
    const deps = { now: () => clock.t, budgetMs: 60, reserveSlot };

    // Pass 1 reproduces the report exactly: truncated, and nothing released despite free capacity.
    const first = await runHoldReleaseSweep(store, deps);
    expect(first.budgetTruncated).toBe(true);
    expect((first.unevaluatedCount ?? 0)).toBeGreaterThan(0);
    expect(first.released).toEqual([]);

    // Pass 2: the deferred tail is served first and releases — the pairing is broken.
    const second = await runHoldReleaseSweep(store, deps);
    expect(second.rotatedDeferredCount).toBeGreaterThan(0);
    expect(second.released.length).toBeGreaterThan(0);
    expect(second.released).toContain("C-04");
    const line = [...warn.mock.calls].map((call) => String(call[0])).find((l) => l.includes("rotated-deferred="));
    expect(line).toBeDefined();
  });

  it("a deferred id that left the board shifts nothing else", async () => {
    const tasks = [task("S-A"), task("S-B"), task("S-C")];
    const clock = { t: 1_000 };
    const store = storeWith(tasks, clock, { blowDeadline: true });

    const first = await runHoldReleaseSweep(store, { now: () => clock.t, budgetMs: 10 });
    expect(first.budgetTruncated).toBe(true);
    expect(heldOrder(first)).toEqual(["S-A"]);

    // The deferred id S-B leaves the board before the next pass; only S-C survives out of the tail.
    tasks.splice(tasks.findIndex((t) => t.id === "S-B"), 1);
    const second = await runHoldReleaseSweep(store, { now: () => clock.t });
    // The stale id is ignored silently — no error, and the surviving deferred card still leads.
    expect(second.rotatedDeferredCount).toBe(1);
    expect(heldOrder(second)).toEqual(["S-C", "S-A"]);
  });
});
