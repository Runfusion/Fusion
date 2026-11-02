/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The hold/release sweep has ALWAYS known why a card did not cross — it computes one held reason per refused
candidate (`downstream-full`, `move-rejected-or-no-slot`, `no-downstream-capacity-column`, `awaiting-planning`,
`awaiting-approval`) — and fed it to `trackHeld`, an in-process `Map` that a restart wipes and that never put
a single word on the card. That is the second half of the reported defect: the board could show a card being
refused every few minutes for two days while the card itself explained nothing, and the operator's only
source was an audit table nobody reads.

These tests pin the publication half of the fix, at the sweep seam rather than on the recorder's unit:
1. the SAME verdict the sweep reports in `result.held` is what lands on the row, with the pool and the first
   occupancy sample, so a reader can tell "the WIP column is full" from "no pool was ever consulted";
2. repetition is bounded by the refresh floor — the row-rate arithmetic that makes ~3 records/minute
   impossible (the measured pre-fix rate was 16 536 refusals for one card over 2 d 19 h);
3. a human or timer wait publishes NOTHING. A card behind `release: "manual"` waits for a person, and
   labeling that `capacity` sends the operator to a limit slider that has nothing to do with the hold —
   RUFU-372's two-shapes-one-label defect, which this task must not re-create one level down.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { WIP_ADMISSION_STALL_METADATA_KEY, WIP_ADMISSION_STALL_REFRESH_FLOOR_MS } from "@fusion/core";

import { runHoldReleaseSweep, resetHoldReleaseInstrumentation } from "../execution/hold-release.js";
/*
FNXC:WipAdmissionPark 2026-11-02-09:21 (RUFU-393 code-review P0):
The sweep's verdict and the dispatch decision it feeds are tested over ONE fake store here, because the defect
lived in the seam between them: the sweep published a `downstream-full` verdict for a card that still had a
pending Plan Review in the same column, and the dispatcher read that verdict as "run nothing". A marker test
with zero work items could not see it — the marker alone looks correct either way.
*/
import { wipAdmissionInLaneWorkProbe, wipAdmissionParkDefersGraphEntry } from "../execution/wip-admission-park.js";
import { schedulerLog } from "../logger.js";

const WF = "custom:park-marker-wf";
const HOUR = 60 * 60_000;

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
    // A planned prompt stating no premises is vacuously satisfied, so the plan-premise gate never
    // substitutes itself for the capacity question under test.
    prompt: "# Planned\n\n## Mission\nImplement the approved work.\n",
    ...over,
  } as Task;
}

/** The Coding shape: a capacity hold on `todo` releasing into one WIP-limited column. */
function singleWipIr(release: "capacity" | "manual" | "external-event" | "timer" = "capacity"): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    /*
    FNXC:WipAdmissionPark 2026-11-02-09:21 (RUFU-393 code-review P0):
    Real nodes, not an empty list. The sweep itself reads only `columns`, but this harness now also feeds the
    DISPATCH decision, whose second authority maps a card's pending work items onto the column their node is
    authored in — a probe over `nodes: []` could only ever answer "no work pending", which is precisely the
    blind spot that froze parked cards.
    */
    nodes: [
      { id: "plan", kind: "prompt", column: "todo" },
      { id: "plan-review", kind: "prompt", column: "todo" },
      { id: "parse", kind: "prompt", column: "in-progress" },
      { id: "implement", kind: "prompt", column: "in-progress" },
    ],
    edges: [],
    columns: [
      {
        id: "todo",
        label: "Todo",
        traits: release === "timer"
          ? [{ trait: "hold", config: { release: "timer", timerMs: HOUR } }]
          : [{ trait: "hold", config: { release } }],
      },
      { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

interface SweepStore {
  store: TaskStore;
  /** Every `sourceMetadataPatch` the sweep wrote, in order — the durable half of the publication. */
  markerPatches: Array<Record<string, unknown>>;
  history: string[];
}

function storeWith(tasks: Task[], ir: WorkflowIr, settings: Record<string, unknown>, moved = true, workItems: Array<{ nodeId: string; state: string }> = []): SweepStore {
  const selection = { workflowId: WF, stepIds: [] };
  const markerPatches: Array<Record<string, unknown>> = [];
  const history: string[] = [];
  const store = {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async () => tasks),
    /*
    FNXC:WipAdmissionPark 2026-11-02-09:21 (RUFU-393 code-review P0):
    The card's unfinished graph work, served by the SAME store the sweep writes its verdict through, so a
    test can take the sweep's published marker into the dispatch decision without a second fake whose work
    items could silently disagree with the row under test.
    */
    listWorkflowWorkItemsForTask: vi.fn(async () =>
      workItems.map((item, index) => ({ taskId: "READY", kind: "task", ordinal: index, attempt: 1, ...item })),
    ),
    moveTaskIf: vi.fn(async (id: string, column: string) => {
      const cur = tasks.find((t) => t.id === id)!;
      if (moved) cur.column = column;
      return { task: cur, moved };
    }),
    /*
    FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
    The fake store APPLIES the patch the way the real one does. A recorder that bounded its writes by reading
    the episode off the row cannot be tested against a store that silently drops what it wrote: an
    apply-nothing fake made every one of 60 passes look like the first refusal, and the floor looked broken
    in exactly the direction that would have hidden a real regression.
    */
    updateTask: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const cur = tasks.find((t) => t.id === id);
      const patch_ = patch.sourceMetadataPatch;
      if (cur && patch_ && typeof patch_ === "object") {
        cur.sourceMetadata = { ...(cur.sourceMetadata ?? {}), ...(patch_ as Record<string, unknown>) };
        if (WIP_ADMISSION_STALL_METADATA_KEY in (patch_ as object)) markerPatches.push(patch_ as Record<string, unknown>);
      }
      return cur ?? undefined;
    }),
    logEntryOnce: vi.fn(async (_id: string, entry: { action: string }) => {
      history.push(entry.action);
      return true;
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
  } as unknown as TaskStore;
  return { store, markerPatches, history };
}

function clock(startMs = Date.parse("2026-11-02T00:00:00.000Z")) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** The LAST episode the sweep wrote — the episode a reader would find on the row. */
function episodeOf(store: SweepStore): Record<string, unknown> | undefined {
  for (const patch of [...store.markerPatches].reverse()) {
    const value = patch[WIP_ADMISSION_STALL_METADATA_KEY];
    // A clear patches the key to `null`, which is a different patch and not an episode.
    if (value && typeof value === "object") return value as Record<string, unknown>;
  }
  return undefined;
}

describe("hold/release sweep publishes the withheld crossing onto the card", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
  });

  it("writes the measured downstream-full verdict, with the pool and its first sample", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const contender = task({ id: "READY", column: "todo" });
    const liveOccupant = task({ id: "LIVE", column: "in-progress" });
    const harness = storeWith([contender, liveOccupant], singleWipIr(), { maxConcurrent: 1 });

    const result = await runHoldReleaseSweep(harness.store, { now: clock().now });

    expect(result.held).toContainEqual({ taskId: "READY", reason: "downstream-full" });
    const episode = episodeOf(harness);
    expect(episode).toMatchObject({
      code: "downstream-full",
      signature: "capacity|todo->in-progress",
      fromColumn: "todo",
      toColumn: "in-progress",
      poolId: WF,
      occupants: 1,
      limit: 1,
      stallCount: 1,
    });
    // The card face is the operator surface; the pool id is what distinguishes "this workflow's column is
    // full" from "someone else's limit binds", which Step 1 proved is per project, never host-wide.
    expect(harness.history.join("\n")).toContain("downstream-full");
    expect(harness.history.join("\n")).toContain("1 of 1 slots");
  });

  it("records one episode per refresh floor under a sustained refusal, not one per pass", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const contender = task({ id: "READY", column: "todo" });
    const liveOccupant = task({ id: "LIVE", column: "in-progress" });
    const harness = storeWith([contender, liveOccupant], singleWipIr(), { maxConcurrent: 1 });
    const time = clock();

    // A whole hour at the measured poll rate (~3/min → 180 passes). Pre-fix, each pass appended an audit
    // row for a card whose row never changed; the durable episode is what bounds it now.
    for (let minute = 0; minute < 60; minute += 1) {
      await runHoldReleaseSweep(harness.store, { now: time.now });
      time.advance(60_000);
    }

    /*
    The arithmetic, stated rather than waved at: one hour of passes at any cadence finer than the floor crosses
    the floor boundary at t=0, 15, 30 and 45 minutes and at no other minute, so EXACTLY four records can exist —
    ~45x fewer than the pre-fix audit-row rate this replaces, and bounded no matter how often the sweep runs. A
    pass that falls inside a floor must write nothing at all.
    */
    expect(WIP_ADMISSION_STALL_REFRESH_FLOOR_MS).toBe(15 * 60_000);
    expect(harness.markerPatches).toHaveLength(HOUR / WIP_ADMISSION_STALL_REFRESH_FLOOR_MS);
    const episode = episodeOf(harness);
    // One wait, one clock: the counter counts RECORDS, while the age still reads the first refusal.
    expect(Number(episode?.stallCount)).toBeGreaterThan(1);
    expect(Date.parse(String(episode?.firstAt))).toBe(Date.parse("2026-11-02T00:00:00.000Z"));
  });

  it("publishes move-rejected-or-no-slot when a slot looked free and the in-transaction move refused", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const contender = task({ id: "READY", column: "todo" });
    // The lane reads below its limit, so the sweep's own count says "room"; the store still refuses.
    const harness = storeWith([contender], singleWipIr(), { maxConcurrent: 3 }, false);

    const result = await runHoldReleaseSweep(harness.store, { now: clock().now });

    expect(result.held).toContainEqual({ taskId: "READY", reason: "move-rejected-or-no-slot" });
    expect(episodeOf(harness)).toMatchObject({ code: "move-rejected-or-no-slot" });
    expect(contender.column).toBe("todo");
  });

  it.each(["manual", "external-event"] as const)(
    "publishes nothing for a %s hold, because that card waits for a person or an event",
    async (release) => {
      vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
      const held = task({ id: "HUMAN", column: "todo" });
      const liveOccupant = task({ id: "LIVE", column: "in-progress" });
      const harness = storeWith([held, liveOccupant], singleWipIr(release), { maxConcurrent: 1 });

      const result = await runHoldReleaseSweep(harness.store, { now: clock().now });

      expect(result.held).toContainEqual({ taskId: "HUMAN", reason: `${release}-only` });
      expect(harness.markerPatches).toEqual([]);
      expect(harness.history).toEqual([]);
    },
  );

  it("publishes nothing for a timer that has not elapsed, because a scheduled wait is not a stall", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const startedAt = new Date(Date.parse("2026-11-02T00:00:00.000Z")).toISOString();
    // The deadline counts from the column crossing, so the card must have ARRIVED recently for the wait to be
    // genuinely pending — an old `columnMovedAt` elapses the timer and the card releases instead of holds.
    const held = task({ id: "TIMED", column: "todo", columnMovedAt: startedAt, createdAt: startedAt });
    const harness = storeWith([held], singleWipIr("timer"), { maxConcurrent: 1 });

    const result = await runHoldReleaseSweep(harness.store, { now: clock().now });

    expect(result.held).toContainEqual({ taskId: "TIMED", reason: "timer-not-elapsed" });
    expect(harness.markerPatches).toEqual([]);
  });

  it("publishes nothing for a card it released, so a released card never carries a fresh refusal", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const contender = task({ id: "READY", column: "todo" });
    const harness = storeWith([contender], singleWipIr(), { maxConcurrent: 1 });

    const result = await runHoldReleaseSweep(harness.store, { now: clock().now });

    expect(result.released).toContain("READY");
    expect(harness.markerPatches).toEqual([]);
  });

  /*
  FNXC:WipAdmissionPark 2026-11-02-09:21 (RUFU-393 code-review P0):
  The seam the review found, closed end to end: the sweep writes a real verdict onto a real row, and the
  dispatcher then reads THAT row against THAT store's work items. Two cases, one per direction, because the
  storm bound and the starvation guard are one function and either can break alone — and a harness with zero
  work items could not see the difference, which is how the freeze shipped.
  */
  it("parks a card that still has Plan Review work in its own column without freezing that work", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const contender = task({ id: "READY", column: "todo" });
    const liveOccupant = task({ id: "LIVE", column: "in-progress" });
    const harness = storeWith([contender, liveOccupant], singleWipIr(), { maxConcurrent: 1 }, true, [
      { nodeId: "plan-review", state: "runnable" },
    ]);
    const time = clock();

    await runHoldReleaseSweep(harness.store, { now: time.now });

    // The verdict was really published — this is not a test that passes because nothing was written.
    expect(episodeOf(harness)).toMatchObject({ code: "downstream-full", fromColumn: "todo" });
    // …and the card is still allowed to run its own planning work.
    const deferred = await wipAdmissionParkDefersGraphEntry(contender, wipAdmissionInLaneWorkProbe(harness.store), time.now());
    expect(deferred).toBeUndefined();
  });

  it("defers the same verdict once the card's only unfinished work is the crossing itself", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    const contender = task({ id: "READY", column: "todo" });
    const liveOccupant = task({ id: "LIVE", column: "in-progress" });
    // The continuation lives at `parse`, in the column entry is being refused to: re-entering re-parks it.
    const harness = storeWith([contender, liveOccupant], singleWipIr(), { maxConcurrent: 1 }, true, [
      { nodeId: "parse", state: "runnable" },
    ]);
    const time = clock();

    await runHoldReleaseSweep(harness.store, { now: time.now });

    const deferred = await wipAdmissionParkDefersGraphEntry(contender, wipAdmissionInLaneWorkProbe(harness.store), time.now());
    expect(deferred?.episode.code).toBe("downstream-full");
  });
});
