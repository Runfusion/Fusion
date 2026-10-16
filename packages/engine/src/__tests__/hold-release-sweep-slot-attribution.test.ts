/*
FNXC:HoldReleaseSlotAttribution 2026-10-16-17:19 (RUFU-698 Step 1):
Field evidence: `Hold-release sweep: project=…: 30038ms (… evaluate 27126ms over 642 tasks (…, slot=13770ms,
unattributed=13057ms)), released=0, held=3, budget-truncated unevaluated=444`. The `slot` bucket was the
sweep's only un-attributed giant and the call count behind it was unknown, so a "~2s per reservation"
figure could only be inferred from `released`/`held` counters — and an inferred cost cannot be aimed at.

These tests pin the three contracts that make the reservation leg measurable without disturbing the
attribution contract RUFU-209 already established:
 - `slot-calls=N` is the number of reservations the pass performed, so `slot ÷ slot-calls` is a
   measurement rather than an inference;
 - `slot-detail=(…)` is a breakdown printed OUTSIDE the reconciling parenthesis, so the existing
   `(release-config=…, slot=…, unattributed=…)` list keeps its exact meaning (and its literal stays
   green in hold-release-sweep-evaluate-attribution.test.ts);
 - a child that was never named is still shown as `slot:residual`, and no `slot-detail` group appears
   at all when nothing was recorded under it.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { resetHoldReleaseInstrumentation, runHoldReleaseSweep, type HoldReleasePass } from "../execution/hold-release.js";
import { schedulerLog } from "../logger.js";

const WF = "custom:slot-wf";

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

function singleWipIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function storeWith(tasks: Task[], settings: Record<string, unknown>): TaskStore {
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
    getWorkflowDefinition: vi.fn(async () => ({ ir: singleWipIr() })),
  } as unknown as TaskStore;
}

/** 1 ms per `now()` call: a wrapped read IS the bucket magnitude, so sizes are counts, not estimates. */
function tickingClock(startMs = 1_000_000) {
  let t = startMs;
  return { now: () => (t += 1) };
}

/** Parse `name=123ms` pairs out of one printed group, e.g. the `slot-detail=(…)` breakdown. */
function parseGroup(line: string, group: string): Record<string, number> | undefined {
  const match = new RegExp(`${group}=\\(([^)]*)\\)`).exec(line);
  if (!match) return undefined;
  const out: Record<string, number> = {};
  for (const part of match[1].split(", ")) {
    const [name, value] = part.split("=");
    if (name && value?.endsWith("ms")) out[name] = Number(value.slice(0, -2));
  }
  return out;
}

describe("hold-release sweep slot attribution (RUFU-698)", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
  });

  it("counts reservations and breaks the slot bucket down without touching the reconciling list", async () => {
    const debug = vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const held = task({ id: "S-1", column: "todo" });
    const store = storeWith([held], { maxConcurrent: 4 });
    const clock = tickingClock();

    // The reservation is refused (returns null), so the card stays held and the pass still records
    // the leg it spent — a deferred reservation is exactly the `released=0` shape from the field line.
    const result = await runHoldReleaseSweep(store, {
      now: clock.now,
      reserveSlot: async (_task: Task, _target: string, pass?: HoldReleasePass) => {
        await pass?.wall("slot:claim-snapshot", async () => { clock.now(); clock.now(); });
        await pass?.wall("slot:admission", async () => { clock.now(); });
        return null;
      },
    });
    expect(result.released).toEqual([]);

    const line = debug.mock.calls.map((call) => String(call[0])).find((l) => l.includes("Hold-release sweep:"));
    expect(line).toBeDefined();
    // Measured call count: `slot ÷ slot-calls` is now arithmetic on the line, not an inference.
    expect(line).toContain("slot-calls=1");
    const detail = parseGroup(line!, "slot-detail");
    expect(detail).toBeDefined();
    expect(detail!["slot:claim-snapshot"]).toBeGreaterThan(0);
    expect(detail!["slot:admission"]).toBeGreaterThan(0);

    /*
    Children are recorded as full wall windows and never enter `phases`, so the reconciling parenthesis
    keeps RUFU-209's meaning byte-for-byte: the field set and its order are unchanged, and the listed
    values plus `unattributed` still reconcile to `evaluate`.
    */
    const reconcile = /\(release-config=(\d+)ms, dependency=(\d+)ms, readiness=(\d+)ms, issue-release=(\d+)ms, prompt=(\d+)ms, unplanned=(\d+)ms, workitem=(\d+)ms, handoff=(\d+)ms, slot=(\d+)ms, unattributed=(\d+)ms\)/.exec(line!);
    expect(reconcile).not.toBeNull();
    const numbers = reconcile!.slice(1).map(Number);
    const slotMs = numbers[8]!;
    const unattributedMs = numbers[9]!;
    const evaluateMs = Number(/evaluate (\d+)ms/.exec(line!)![1]);
    expect(numbers.slice(0, 9).reduce((sum, ms) => sum + ms, 0) + unattributedMs).toBe(evaluateMs);
    expect(slotMs).toBeGreaterThan(0);
    const childSum = Object.entries(detail!).reduce((sum, [name, ms]) => (name === "slot:residual" ? sum : sum + ms), 0);
    expect(childSum).toBeLessThanOrEqual(slotMs);
    expect(line!.indexOf("slot-detail=")).toBeGreaterThan(line!.indexOf("unattributed="));
  });

  it("prints no slot-detail group when nothing reserved, so an empty bucket cannot look like a cost", async () => {
    const debug = vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    // A block card releases nothing and reaches no reservation line at all.
    const blocked = task({ id: "S-2", column: "in-progress" });
    const store = storeWith([blocked], { maxConcurrent: 4 });
    await runHoldReleaseSweep(store, { now: tickingClock().now });

    const line = debug.mock.calls.map((call) => String(call[0])).find((l) => l.includes("Hold-release sweep:"));
    expect(line).toBeDefined();
    expect(line).toContain("slot-calls=0");
    expect(line).not.toContain("slot-detail=");
  });

  it("shows an unclaimed slice as slot:residual and still prints children it does not know", async () => {
    const debug = vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const held = task({ id: "S-3", column: "todo" });
    const store = storeWith([held], { maxConcurrent: 4 });
    const clock = tickingClock();

    await runHoldReleaseSweep(store, {
      now: clock.now,
      reserveSlot: async (_task: Task, _target: string, pass?: HoldReleasePass) => {
        // One named child plus unobserved work between the child windows.
        await pass?.wall("slot:unknown-child", async () => { clock.now(); clock.now(); clock.now(); });
        clock.now();
        clock.now();
        return null;
      },
    });

    const line = debug.mock.calls.map((call) => String(call[0])).find((l) => l.includes("Hold-release sweep:"));
    const detail = parseGroup(line!, "slot-detail");
    expect(detail).toBeDefined();
    // An unexpected cost surfaces as a number instead of vanishing into the parent bucket.
    expect(detail!["slot:unknown-child"]).toBeGreaterThan(0);
    expect(detail!["slot:residual"]).toBeGreaterThan(0);
    expect(line).toContain("slot-calls=1");
  });
});
