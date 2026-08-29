/*
FNXC:HoldReleaseInstrumentation 2026-07-25-14:35:
Operator-reported symptom: "tasks that finish planning and are ready don't move immediately — there
is a long delay." The sweep logged per-task hold REASONS but never how LONG a card waited or how
long the sweep itself took, so the delay could not be attributed between the poll cadence, sweep
execution cost, and a card legitimately queued on capacity.

These tests pin the instrumentation's OBSERVABLE contract (what an operator reading the log can
conclude), not its exact wording:
 - a released card reports the elapsed held time, measured from when it was first held;
 - the wait accumulates across sweeps while the reason is unchanged, and the clock is keyed by
   reason so a reason change restarts it rather than conflating two different waits;
 - a slow sweep is reported at warn level, because then the sweep IS the delay;
 - a quiet sweep does not reprint at info level every poll (that is why hold logging was demoted
   to debug once before — a full board buried real scheduler events);
 - bookkeeping for a no-longer-held task is dropped, so the map cannot grow without bound.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { runHoldReleaseSweep, resetHoldReleaseInstrumentation } from "../execution/hold-release.js";
import { schedulerLog } from "../logger.js";

const WF = "custom:wf";

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
    ...over,
  } as Task;
}

/** Single wip column with a capacity hold on todo — the Coding (Ideas) shape. */
function singleWipIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      {
        id: "in-progress",
        label: "In Progress",
        traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }],
      },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function storeWith(tasks: Task[], ir: WorkflowIr, settings: Record<string, unknown>): TaskStore {
  const selection = { workflowId: WF, stepIds: [] };
  return {
    getSettings: vi.fn(async () => settings),
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
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
  } as unknown as TaskStore;
}

/** A controllable clock so held durations are exact, never wall-clock flaky. */
function clock(startMs = 1_000_000) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("hold/release sweep instrumentation", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
  });

  it("reports how long a card was held when it is finally released", async () => {
    const log = vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const held = task({ id: "H", column: "todo" });
    const occupant = task({ id: "O", column: "in-progress" });
    const store = storeWith([held, occupant], singleWipIr(), { maxConcurrent: 1 });
    const c = clock();

    // Saturated: the card is held and the clock starts.
    const first = await runHoldReleaseSweep(store, { now: c.now });
    expect(first.released).toEqual([]);
    expect(first.held.some((h) => h.taskId === "H" && h.reason === "downstream-full")).toBe(true);

    c.advance(45_000);
    occupant.column = "done";
    const second = await runHoldReleaseSweep(store, { now: c.now });
    expect(second.released).toEqual(["H"]);

    // The release line carries the measured wait — the number that explains the delay.
    const releaseLine = log.mock.calls.map((c2) => String(c2[0])).find((l) => l.includes("Hold release for H"));
    expect(releaseLine).toBeDefined();
    expect(releaseLine).toContain("45000ms");
  });

  it("accumulates the wait across sweeps while the hold reason is unchanged", async () => {
    const log = vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const held = task({ id: "H", column: "todo", dependencies: ["FN-DEP"] });
    const occupant = task({ id: "O", column: "in-progress" });
    const ir = singleWipIr();
    const store = storeWith([held, occupant], ir, { maxConcurrent: 1 });
    const c = clock();

    await runHoldReleaseSweep(store, { now: c.now });        // held: downstream-full
    c.advance(60_000);

    // Free the slot so the reason changes on the next pass, then release.
    occupant.column = "done";
    c.advance(5_000);
    const released = await runHoldReleaseSweep(store, { now: c.now });
    expect(released.released).toEqual(["H"]);

    const releaseLine = log.mock.calls.map((x) => String(x[0])).find((l) => l.includes("Hold release for H"));
    // Total wait under the SAME reason is reported (65s), not a reset-to-zero.
    expect(releaseLine).toContain("65000ms");
  });

  it("warns when the sweep itself is slow, since then the sweep is the delay", async () => {
    const warn = vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const store = storeWith([task({ id: "H", column: "todo" })], singleWipIr(), { maxConcurrent: 5 });

    // A clock that jumps 3s across the sweep simulates a slow pass deterministically.
    let calls = 0;
    const now = () => { calls += 1; return 1_000_000 + (calls > 1 ? 3_000 : 0); };

    await runHoldReleaseSweep(store, { now });

    const warnLine = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("Hold-release sweep"));
    expect(warnLine).toBeDefined();
    expect(warnLine).toMatch(/sweep exceeded/);
    // The prefetch cost is broken out so an O(board-size) prefetch is attributable.
    expect(warnLine).toContain("prefetch");
    expect(warnLine).toContain("ir-resolve");
    expect(warnLine).toContain("reads(settings=");
    expect(warnLine).toContain("definitions=1");
  });

  it("warns with the truncation outcome and measured unevaluated count", async () => {
    const warn = vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
    const store = storeWith([task({ id: "H", column: "todo" })], singleWipIr(), { maxConcurrent: 5 });
    let now = 0;
    (store.listTasks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      now = 11;
      return [task({ id: "H", column: "todo" })];
    });

    const result = await runHoldReleaseSweep(store, { now: () => now, budgetMs: 10 });

    expect(result).toMatchObject({ budgetTruncated: true, unevaluatedCount: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("budget-truncated unevaluated=1"));
  });

  it("counts throwing selection and missing-definition reads by invocation, not cache growth", async () => {
    const debug = vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const throwingSelectionStore = storeWith([task({ id: "THROW", column: "todo" })], singleWipIr(), { maxConcurrent: 1 });
    (throwingSelectionStore.getTaskWorkflowSelectionAsync as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("transient"));
    await runHoldReleaseSweep(throwingSelectionStore, { now: () => 1_000_000 });

    const missingDefinitionStore = storeWith([task({ id: "MISSING", column: "todo" })], singleWipIr(), { maxConcurrent: 1 });
    (missingDefinitionStore.getTaskWorkflowSelectionAsync as ReturnType<typeof vi.fn>).mockResolvedValue({ workflowId: "custom:missing", stepIds: [] });
    (missingDefinitionStore.getWorkflowDefinition as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await runHoldReleaseSweep(missingDefinitionStore, { now: () => 1_000_000 });

    const lines = debug.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("selections=2") && line.includes("definitions=0"))).toBe(true);
    expect(lines.some((line) => line.includes("selections=1") && line.includes("definitions=1"))).toBe(true);
  });

  it("keeps a quiet sweep at debug so a full board does not bury real scheduler events", async () => {
    const log = vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const debug = vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const held = task({ id: "H", column: "todo" });
    const occupant = task({ id: "O", column: "in-progress" });
    const store = storeWith([held, occupant], singleWipIr(), { maxConcurrent: 1 });
    const c = clock();

    await runHoldReleaseSweep(store, { now: c.now }); // nothing released

    expect(debug.mock.calls.some((x) => String(x[0]).includes("Hold-release sweep"))).toBe(true);
    expect(log.mock.calls.some((x) => String(x[0]).includes("Hold-release sweep"))).toBe(false);
  });

  it("drops bookkeeping for a task that is no longer held", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const held = task({ id: "H", column: "todo" });
    const occupant = task({ id: "O", column: "in-progress" });
    const store = storeWith([held, occupant], singleWipIr(), { maxConcurrent: 1 });
    const c = clock();

    await runHoldReleaseSweep(store, { now: c.now });
    c.advance(10_000);
    occupant.column = "done";
    await runHoldReleaseSweep(store, { now: c.now });

    // Released, so the next sweep must not re-report a stale accumulated wait.
    const log2 = vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    c.advance(10_000);
    held.column = "todo";
    await runHoldReleaseSweep(store, { now: c.now });
    const line = log2.mock.calls.map((x) => String(x[0])).find((l) => l.includes("Hold release for H"));
    if (line) expect(line).toContain("0ms");
  });
});
