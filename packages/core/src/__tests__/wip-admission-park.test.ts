import { describe, expect, it } from "vitest";
import type { Task } from "../types.js";
import {
  WIP_ADMISSION_STALL_ESCALATION_FLOOR_MS,
  WIP_ADMISSION_STALL_REFRESH_FLOOR_MS,
  clearWipAdmissionStallPatch,
  formatWipAdmissionStallWait,
  readWipAdmissionStallEpisode,
  wipAdmissionParkSignature,
  wipAdmissionStallAgeMs,
  wipAdmissionStallWrite,
  type WipAdmissionStallObservation,
} from "../tasks/wip-admission-park.js";
import { deriveTaskStallReason, type TaskStallReasonContext } from "../tasks/task-stall-reason.js";
import { WIP_ADMISSION_STALL_METADATA_KEY } from "../types.js";

/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The row-flood contract for the execution lane's twin of RUFU-273. The measured storm was 16 536 audit rows
for ONE card refused at the same boundary for 2 d 19 h, so these tests pin the two properties that make the
episode a bound rather than a second counter: an unchanged wait inside the refresh floor writes NOTHING, and
an unchanged wait across the floor refreshes in place without moving `firstAt`. The rest pin what the
identity deliberately excludes — the refusing gate and the raw occupant count — because those are precisely
the fields that fluctuate while the same wait continues.
*/

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-11-01T12:00:00.000Z");

function observation(overrides: Partial<WipAdmissionStallObservation> = {}): WipAdmissionStallObservation {
  return {
    code: "scheduler-seam",
    signature: wipAdmissionParkSignature({ reason: "capacity", fromColumn: "todo", toColumn: "in-progress" }),
    nodeId: "parse",
    fromColumn: "todo",
    toColumn: "in-progress",
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-393",
    projectId: "p1",
    title: "wip admission fixture",
    description: "",
    status: null,
    column: "todo",
    paused: false,
    priority: "normal",
    createdAt: new Date(NOW - HOUR).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    steps: [],
    currentStep: 0,
    log: [],
    ...overrides,
  } as unknown as Task;
}

function ctx(overrides: Partial<TaskStallReasonContext> = {}): TaskStallReasonContext {
  return { now: NOW, ...overrides };
}

function episodeAgedAgo(ms: number, code = "scheduler-seam") {
  const at = new Date(NOW - ms).toISOString();
  return { code, signature: "sig", nodeId: "parse", fromColumn: "todo", toColumn: "in-progress", lastAt: at, firstAt: at, stallCount: 3 };
}

describe("wipAdmissionStallWrite", () => {
  it("records a genuinely different wait immediately, restarting the clock", () => {
    const t0 = Date.parse("2026-11-01T00:00:00.000Z");
    const first = wipAdmissionStallWrite(undefined, observation(), t0)!;
    expect(first.stallCount).toBe(1);
    expect(first.firstAt).toBe(new Date(t0).toISOString());

    // A different boundary is a different wait, so it may not be swallowed by the same-signature floor.
    const other = wipAdmissionStallWrite(first, observation({
      signature: wipAdmissionParkSignature({ reason: "capacity", fromColumn: "todo", toColumn: "review" }),
    }), t0 + 1_000)!;
    expect(other.signature).not.toBe(first.signature);
    expect(other.stallCount).toBe(1);
    expect(other.firstAt).toBe(new Date(t0 + 1_000).toISOString());
  });

  it("writes nothing for an unchanged wait inside the refresh floor", () => {
    const t0 = Date.parse("2026-11-01T00:00:00.000Z");
    const first = wipAdmissionStallWrite(undefined, observation(), t0)!;
    expect(wipAdmissionStallWrite(first, observation(), t0 + WIP_ADMISSION_STALL_REFRESH_FLOOR_MS - 1_000)).toBeUndefined();
  });

  it("refreshes in place past the floor, preserving firstAt and counting the repeat", () => {
    const t0 = Date.parse("2026-11-01T00:00:00.000Z");
    const first = wipAdmissionStallWrite(undefined, observation(), t0)!;
    const later = t0 + 40 * WIP_ADMISSION_STALL_REFRESH_FLOOR_MS;
    const refreshed = wipAdmissionStallWrite(first, observation(), later)!;
    expect(refreshed.firstAt).toBe(first.firstAt);
    expect(refreshed.lastAt).toBe(new Date(later).toISOString());
    expect(refreshed.stallCount).toBe(2);
  });

  it("keeps one identity across a whole measured wait so age survives the refresh cycle", () => {
    const t0 = Date.parse("2026-10-18T00:00:00.000Z");
    let episode = wipAdmissionStallWrite(undefined, observation(), t0)!;
    // 2 d 19 h of polls at the refresh cadence: one episode, one clock, ~183 records — not 16 536 rows.
    let writes = 1;
    const end = t0 + 2 * 24 * HOUR + 19 * HOUR;
    for (let at = t0 + WIP_ADMISSION_STALL_REFRESH_FLOOR_MS; at < end; at += 60_000) {
      const next = wipAdmissionStallWrite(episode, observation(), at);
      if (next) {
        writes += 1;
        episode = next;
      }
    }
    // One record per refresh floor, not one per poll: 67 h at a 15-minute bound is a few hundred rows,
    // where the pre-fix engine wrote one audit row per dispatch for the same wait (16 536 rows observed).
    expect(writes).toBeLessThanOrEqual(300);
    expect(16_536 / writes).toBeGreaterThan(50);
    expect(episode.firstAt).toBe(new Date(t0).toISOString());
    expect(wipAdmissionStallAgeMs(episode, end)).toBe(end - t0);
  });

  it("sharpens the gate on a same-identity refresh but never dulls it", () => {
    const t0 = Date.parse("2026-11-01T00:00:00.000Z");
    const seam = wipAdmissionStallWrite(undefined, observation(), t0)!;
    const later = t0 + WIP_ADMISSION_STALL_REFRESH_FLOOR_MS;

    // The sweep measured the pool: the lazy `scheduler-seam` label must give way to the named arm.
    const sharpened = wipAdmissionStallWrite(seam, observation({ code: "column-capacity", occupants: 4, limit: 4 }), later)!;
    expect(sharpened.code).toBe("column-capacity");
    expect(sharpened.occupants).toBe(4);
    expect(sharpened.firstAt).toBe(seam.firstAt);

    // A later lazy reading may not erase the measurement it came on top of.
    const dulled = wipAdmissionStallWrite(sharpened, observation(), later + WIP_ADMISSION_STALL_REFRESH_FLOOR_MS)!;
    expect(dulled.code).toBe("column-capacity");
  });

  it("keeps the identity the crossing alone, so refining the observation cannot restart the age", () => {
    const crossing = wipAdmissionParkSignature({ reason: "capacity", fromColumn: "todo", toColumn: "in-progress" });
    // A different boundary is a different wait and must not collapse into this one.
    expect(wipAdmissionParkSignature({ reason: "capacity", fromColumn: "todo", toColumn: "review" })).not.toBe(crossing);
    // Two parts is the whole claim: nothing an observer can disagree about is in here.
    expect(crossing.split("|")).toHaveLength(2);
  });

  it("preserves the age when the measured sweep verdict arrives on the graph's parked episode", () => {
    const t0 = Date.parse("2026-11-01T00:00:00.000Z");
    const graphSignature = wipAdmissionParkSignature({ reason: "capacity", fromColumn: "todo", toColumn: "in-progress" });
    const parked = wipAdmissionStallWrite(undefined, observation({ signature: graphSignature }), t0)!;
    const later = t0 + WIP_ADMISSION_STALL_REFRESH_FLOOR_MS;
    // This is the regression RUFU-393's own engine test caught: pool facts entering the identity made the
    // sweep's first measurement split one two-day wait into a fresh episode.
    const sharpened = wipAdmissionStallWrite(parked, observation({
      signature: graphSignature,
      code: "column-capacity",
      poolId: "column:in-progress",
      occupants: 4,
      limit: 4,
    }), later)!;
    expect(sharpened.firstAt).toBe(parked.firstAt);
    expect(sharpened.stallCount).toBe(2);
    expect(sharpened.code).toBe("column-capacity");
    expect(sharpened.occupants).toBe(4);
  });
});

/*
FNXC:CapacityGateFacts 2026-11-02-23:20 (RUFU-372 second revision):
The holder forensics ride the SAME accepted episode write as the counts, so three surfaces (audit row,
History line, card-face notice) quote one measurement instead of the three reads that disagreed during
the incident. Two properties are worth pinning because they are the easy ones to lose in a later refactor:
an UNRECORDED holder set stays absent (never an empty list, which claims an empty pool), and a malformed
holder field degrades only itself — dropping the whole episode would erase the wait the card sits in.
*/
describe("wipAdmissionStallWrite — holder forensics", () => {
  it("carries holder ids and the oldest hold onto the episode", () => {
    const written = wipAdmissionStallWrite(
      undefined,
      observation({ poolId: "in-progress", occupants: 2, limit: 2, heldBy: ["RUFU-H1", "RUFU-H2"], oldestHolderAgeMs: 2 * HOUR }),
      NOW,
    )!;
    expect(written.heldBy).toEqual(["RUFU-H1", "RUFU-H2"]);
    expect(written.oldestHolderAgeMs).toBe(2 * HOUR);
  });

  it("keeps an unrecorded holder set absent rather than writing an empty list", () => {
    const written = wipAdmissionStallWrite(undefined, observation({ poolId: "in-progress", occupants: 2, limit: 2 }), NOW)!;
    // An empty list would claim "we looked and the pool was empty"; absence claims "nobody recorded it".
    // The card face renders those as two different sentences, so the stored shape must keep them apart.
    expect("heldBy" in written).toBe(false);
    expect("oldestHolderAgeMs" in written).toBe(false);
  });

  it("preserves a genuinely empty holder list as empty", () => {
    const written = wipAdmissionStallWrite(undefined, observation({ heldBy: [] }), NOW)!;
    expect(written.heldBy).toEqual([]);
  });

  it("caps the stored holder ids so one wide pool cannot bloat every board payload", () => {
    const many = Array.from({ length: 60 }, (_unused, index) => `TASK-${index}`);
    const written = wipAdmissionStallWrite(undefined, observation({ heldBy: many }), NOW)!;
    expect(written.heldBy!.length).toBeLessThanOrEqual(20);
    expect(written.heldBy![0]).toBe("TASK-0");
  });

  it("degrades a malformed holder field without losing the episode it belongs to", () => {
    const dirty = ["OK-1", 42, "  "] as unknown as string[];
    const written = wipAdmissionStallWrite(undefined, observation({ heldBy: dirty, oldestHolderAgeMs: -5 }), NOW)!;
    const read = readWipAdmissionStallEpisode({ [WIP_ADMISSION_STALL_METADATA_KEY]: written })!;
    expect(read).toBeDefined();
    expect(read.heldBy).toEqual(["OK-1"]);
    expect("oldestHolderAgeMs" in read).toBe(false);
  });
});

describe("readWipAdmissionStallEpisode", () => {
  it("degrades a malformed or hand-edited value to silence rather than throwing", () => {
    const valid = wipAdmissionStallWrite(undefined, observation(), Date.parse("2026-11-01T00:00:00.000Z"))!;
    expect(readWipAdmissionStallEpisode({ [WIP_ADMISSION_STALL_METADATA_KEY]: valid })).toBeDefined();
    expect(readWipAdmissionStallEpisode({ [WIP_ADMISSION_STALL_METADATA_KEY]: { ...valid, code: "made-up" } })).toBeUndefined();
    expect(readWipAdmissionStallEpisode({ [WIP_ADMISSION_STALL_METADATA_KEY]: { ...valid, firstAt: "not-a-date" } })).toBeUndefined();
    expect(readWipAdmissionStallEpisode({ [WIP_ADMISSION_STALL_METADATA_KEY]: "yes" })).toBeUndefined();
    expect(readWipAdmissionStallEpisode(undefined)).toBeUndefined();
  });

  it("clears through a single-key patch so a whole-field wipe cannot happen by accident", () => {
    const patch = clearWipAdmissionStallPatch();
    expect(patch).toEqual({ [WIP_ADMISSION_STALL_METADATA_KEY]: null });
    expect(Object.keys(patch)).toHaveLength(1);
  });
});

describe("deriveTaskStallReason — wip-admission-throttled", () => {
  it("stays silent below the escalation floor so an ordinary wait reports nothing", async () => {
    const task = makeTask({ sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episodeAgedAgo(WIP_ADMISSION_STALL_ESCALATION_FLOOR_MS - 60_000) } });
    const stall = await deriveTaskStallReason(task, ctx());
    expect(stall?.code).not.toBe("wip-admission-throttled");
  });

  it("names the wait once it outlives the floor, carrying the elapsed age", async () => {
    const task = makeTask({ sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episodeAgedAgo(24 * HOUR + 12 * 60_000) } });
    const stall = await deriveTaskStallReason(task, ctx());
    expect(stall?.code).toBe("wip-admission-throttled");
    expect(stall?.waitedMs).toBe(24 * HOUR + 12 * 60_000);
    expect(stall?.reason).toContain("work-in-progress");
  });

  /*
  FNXC:CapacityGateFacts 2026-11-02-23:25 (RUFU-372 second revision):
  The stall row is the ONLY route by which the gate facts reach the dashboard — no board surface can read
  run-audit — so what the episode stores has to survive the derivation unchanged, including the two
  absences that carry meaning (`capacityPoolId: null` = no pool consulted, missing `capacityHeldBy` =
  holders never recorded).
  */
  it("surfaces the gate facts the episode recorded, so the card face can answer without a database query", async () => {
    const episode = {
      ...episodeAgedAgo(24 * HOUR),
      poolId: "in-progress",
      occupants: 2,
      limit: 2,
      heldBy: ["RUFU-H1", "RUFU-H2"],
      oldestHolderAgeMs: 3 * HOUR,
    };
    const stall = await deriveTaskStallReason(makeTask({ sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode } }), ctx());
    expect(stall?.capacityPoolId).toBe("in-progress");
    expect(stall?.capacityOccupants).toBe(2);
    expect(stall?.capacityLimit).toBe(2);
    expect(stall?.capacityHeldBy).toEqual(["RUFU-H1", "RUFU-H2"]);
    expect(stall?.capacityOldestHolderAgeMs).toBe(3 * HOUR);
  });

  it("leaves the holder set absent when the writer never recorded one", async () => {
    const episode = { ...episodeAgedAgo(24 * HOUR), poolId: "in-progress", occupants: 2, limit: 2 };
    const stall = await deriveTaskStallReason(makeTask({ sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode } }), ctx());
    expect(stall?.capacityLimit).toBe(2);
    expect("capacityHeldBy" in (stall ?? {})).toBe(false);
  });

  it("reports no pool for a scheduler-seam episode rather than an empty one", async () => {
    const stall = await deriveTaskStallReason(makeTask({ sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episodeAgedAgo(24 * HOUR) } }), ctx());
    // Absence here is the honest-absence rule: a seam hand-off never consulted a capacity pool, and a
    // zero would read as "an empty pool" — the misread this whole task exists to retire.
    expect(stall?.capacityPoolId).toBeNull();
  });

  it("defers to an operator pause and to any status another authority already owns", async () => {
    const episode = episodeAgedAgo(30 * HOUR);
    const paused = makeTask({ userPaused: true, sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode } });
    const failed = makeTask({ status: "failed", sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode } });
    expect((await deriveTaskStallReason(paused, ctx()))?.code).not.toBe("wip-admission-throttled");
    expect((await deriveTaskStallReason(failed, ctx()))?.code).not.toBe("wip-admission-throttled");
  });

  it("falls silent once the card is no longer on the column the refusal was about", async () => {
    /*
    FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
    The marker is cleared at the move seam, but that clear is fire-and-forget inside a non-reentrant lock, so
    it can be dropped. A released card wearing "waiting for a free work-in-progress slot" is worse than no
    badge at all — it names a slot the card demonstrably does not need — so the derivation refuses to read an
    episode whose `fromColumn` is not where the card now sits. Asserted in BOTH directions: the same aged
    episode badges the card while it waits, and says nothing once it has crossed.
    */
    const episode = episodeAgedAgo(30 * HOUR);
    const waiting = makeTask({ column: "todo", sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode } });
    const crossed = makeTask({ column: "in-progress", sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode } });

    expect((await deriveTaskStallReason(waiting, ctx()))?.code).toBe("wip-admission-throttled");
    expect((await deriveTaskStallReason(crossed, ctx()))?.code).not.toBe("wip-admission-throttled");
  });

  it("outranks a stale planning stall so an execution refusal is never read as a planner problem", async () => {
    const agedAt = new Date(NOW - 30 * HOUR).toISOString();
    const planEpisode = {
      code: "plan-admission-throttled",
      signature: "sweep:gate",
      nodeId: "plan",
      fromColumn: "hold",
      toColumn: "todo",
      lastAt: agedAt,
      firstAt: agedAt,
      stallCount: 2,
    };
    /*
    FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
    The precedence claim is only meaningful if the planning episode still derives on its own, and the planning
    arm is gated on the caller supplying `planningColumns` — an empty context makes the comparison pass with no
    competition at all. The control is therefore asserted first: with the SAME context, the planning episode
    alone really does produce `plan-admission-throttled`.
    */
    const planningCtx = ctx({ planningColumns: new Set<string>(["hold", "todo"]) });
    const planningOnly = makeTask({ sourceMetadata: { planAdmissionStall: planEpisode } });
    expect((await deriveTaskStallReason(planningOnly, planningCtx))?.code).toBe("plan-admission-throttled");

    const both = makeTask({
      sourceMetadata: {
        [WIP_ADMISSION_STALL_METADATA_KEY]: episodeAgedAgo(30 * HOUR),
        planAdmissionStall: planEpisode,
      },
    });
    const stall = await deriveTaskStallReason(both, planningCtx);
    expect(stall?.code).toBe("wip-admission-throttled");
  });
});

describe("formatWipAdmissionStallWait", () => {
  it("renders the elapsed wait compactly for every magnitude", () => {
    expect(formatWipAdmissionStallWait(53 * 60_000)).toBe("53 m");
    expect(formatWipAdmissionStallWait(2 * HOUR + 4 * 60_000)).toBe("2 h 4 m");
    expect(formatWipAdmissionStallWait(2 * 24 * HOUR + 19 * HOUR)).toBe("2 d 19 h");
  });

  it("never reports a negative wait for a clock that ran backwards", () => {
    const at = new Date(Date.parse("2026-11-02T00:00:00.000Z")).toISOString();
    const episode = readWipAdmissionStallEpisode({
      [WIP_ADMISSION_STALL_METADATA_KEY]: {
        code: "scheduler-seam", signature: "s", nodeId: "parse", fromColumn: "todo", toColumn: "in-progress",
        firstAt: at, lastAt: at, stallCount: 1,
      },
    })!;
    expect(wipAdmissionStallAgeMs(episode, Date.parse("2026-11-01T00:00:00.000Z"))).toBe(0);
  });
});
