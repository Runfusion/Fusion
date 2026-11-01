/*
FNXC:HeartbeatIdlePreflight 2026-11-01-15:00 (RUFU-268):
"NEW" IS NOT ONE FACT, AND THE CHEAP PATH MAY ONLY RELY ON THE ONE IT WAS SHOWN.

RUFU-268 gives a timer tick two decisions that depend on WHICH population moved: whether the tick may be
postponed by the idle ladder, and whether it may be answered by a one-line question that sees nothing but
candidate ids. Both are safe for the ambient auto-claim table and unsafe for everything else — an unread
message, a room entry, a new steering comment, or work landing on the agent's own rows carries content the
compact turn never received.

The invariant this suite pins is the one that makes the split safe to ship at all: the split changed which
population is reported, never WHETHER a tick is considered fresh. `hasFresherWakeSignal` still answers true
for every non-`none` kind, so no real signal is newly invisible because a label got finer — and the
idle-eligible set stays exactly one kind, asserted from the exported list rather than from a copy.
*/
import { describe, expect, it } from "vitest";
import {
  WAKE_SIGNAL_KINDS,
  asWakeSignalKind,
  classifyFresherWakeSignal,
  hasFresherWakeSignal,
  isIdleLadderEligibleWakeSignal,
} from "../heartbeat-wake-signals.js";
import { createWakeCursor, createWakeSnapshot } from "./heartbeat-test-helpers.js";

describe("classifyFresherWakeSignal — which population moved", () => {
  it("reports none when every population the cursor covered is unchanged", () => {
    const cursor = createWakeCursor({ assignedRows: ["FN-10:todo"], autoClaimCandidates: ["FN-20"], steeringCommentIds: ["SC-1"] });
    const snapshot = createWakeSnapshot({ assignedRows: ["FN-10:todo"], candidates: ["FN-20"], steeringCommentIds: ["SC-1"] });

    expect(classifyFresherWakeSignal(cursor, snapshot)).toBe("none");
    // The pre-RUFU-268 predicate has to agree, or the ladder would be suppressing ticks the gate thinks
    // are fresh — two authorities over one question.
    expect(hasFresherWakeSignal(cursor, snapshot)).toBe(false);
  });

  it("reads a new steering comment as board CONTENT, which is neither deferrable nor cheaply answerable", () => {
    const snapshot = createWakeSnapshot({ steeringCommentIds: ["SC-NEW"], candidates: ["FN-20"] });
    const kind = classifyFresherWakeSignal(createWakeCursor(), snapshot);

    expect(kind).toBe("board-content");
    expect(hasFresherWakeSignal(createWakeCursor(), snapshot)).toBe(true);
    expect(isIdleLadderEligibleWakeSignal(kind)).toBe(false);
  });

  it("reads a change in the agent's own assigned rows as an ASSIGNMENT, not a candidate reshuffle", () => {
    // Work landing on the agent outranks a reshuffle in both directions: it must not wait for a ladder
    // step, and the compact turn — which is never shown an assigned row — must not answer for it.
    const cursor = createWakeCursor({ assignedRows: ["FN-10:todo"] });
    const moved = classifyFresherWakeSignal(cursor, createWakeSnapshot({ assignedRows: ["FN-10:in-progress"] }));
    const added = classifyFresherWakeSignal(cursor, createWakeSnapshot({ assignedRows: ["FN-10:todo", "FN-11:todo"] }));
    const cleared = classifyFresherWakeSignal(cursor, createWakeSnapshot());

    expect(moved).toBe("board-assignment");
    expect(added).toBe("board-assignment");
    // A row leaving the agent's plate is still an assignment fact: the ladder exists to skip ambient
    // noise, not to decide when a hand-off gets noticed.
    expect(cleared).toBe("board-assignment");
    expect(isIdleLadderEligibleWakeSignal(moved)).toBe(false);
  });

  it("reads a lane change on the assigned task as an assignment even when the rows hash the same", () => {
    const cursor = createWakeCursor({ assignedTaskId: "FN-10", assignedTaskState: "todo" });
    const kind = classifyFresherWakeSignal(cursor, createWakeSnapshot({ assignedTaskState: "in-progress" }));

    expect(kind).toBe("board-assignment");
  });

  it("reads the ambient candidate table moving — appearing, disappearing, or repeating — as the one eligible kind", () => {
    const appeared = classifyFresherWakeSignal(createWakeCursor(), createWakeSnapshot({ candidates: ["FN-30"] }));
    const disappeared = classifyFresherWakeSignal(createWakeCursor({ autoClaimCandidates: ["FN-30"] }), createWakeSnapshot());
    // A duplicate id is not the same SET the cursor covered; the compare is length-then-membership, so a
    // board that reports a candidate twice re-earns the tick rather than being called unchanged.
    const duplicated = classifyFresherWakeSignal(createWakeCursor({ autoClaimCandidates: ["FN-30"] }), createWakeSnapshot({ candidates: ["FN-30", "FN-30"] }));

    expect(appeared).toBe("board-candidates");
    expect(disappeared).toBe("board-candidates");
    expect(duplicated).toBe("board-candidates");
    for (const kind of [appeared, disappeared, duplicated]) {
      expect(isIdleLadderEligibleWakeSignal(kind)).toBe(true);
    }
  });

  it("reports arriving content ahead of anything the board merely rearranged", () => {
    // One cursor, every population moving at once: the kind must name the content, because that is what
    // decides whether the tick may be postponed at all.
    const snapshot = createWakeSnapshot({
      unread: 2,
      roomEntryIds: ["ROOM-1"],
      steeringCommentIds: ["SC-1"],
      assignedRows: ["FN-9:todo"],
      candidates: ["FN-40"],
    });

    expect(classifyFresherWakeSignal(createWakeCursor(), snapshot)).toBe("messages");
    const noInbox = { ...snapshot, inboxUnreadTotal: 0 };
    expect(classifyFresherWakeSignal(createWakeCursor(), noInbox)).toBe("room");
  });

  it("treats every kind the classifier can return as fresh except `none`", () => {
    // The claim that the split moved no tick's verdict, checked over the whole kind list instead of the
    // cases the author happened to think of.
    const snapshotForKind: Record<string, ReturnType<typeof createWakeSnapshot>> = {
      messages: createWakeSnapshot({ unread: 1 }),
      room: createWakeSnapshot({ roomEntryIds: ["ROOM-1"] }),
      "board-content": createWakeSnapshot({ steeringCommentIds: ["SC-1"] }),
      "board-assignment": createWakeSnapshot({ assignedRows: ["FN-1:todo"] }),
      "board-candidates": createWakeSnapshot({ candidates: ["FN-2"] }),
      none: createWakeSnapshot(),
    };

    for (const kind of WAKE_SIGNAL_KINDS) {
      expect(hasFresherWakeSignal(createWakeCursor(), snapshotForKind[kind]!)).toBe(kind !== "none");
      expect(isIdleLadderEligibleWakeSignal(kind)).toBe(kind === "board-candidates");
    }
  });
});

describe("asWakeSignalKind — the narrowing a wiring boundary is allowed to use", () => {
  it("passes a known kind through and refuses to guess an unknown one", () => {
    for (const kind of WAKE_SIGNAL_KINDS) {
      expect(asWakeSignalKind(kind)).toBe(kind);
    }
    // `undefined` means "unclassified", which every consumer answers with the full path. A coercion here
    // (to "none", or to the nearest known kind) would hand an unrecognised signal to a cheap lane.
    expect(asWakeSignalKind("board-candidate-table")).toBeUndefined();
    expect(asWakeSignalKind(undefined)).toBeUndefined();
    expect(asWakeSignalKind(null)).toBeUndefined();
    expect(asWakeSignalKind(42)).toBeUndefined();
  });
});
