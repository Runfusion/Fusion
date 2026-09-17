import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

import {
  compareAdmissionCandidates,
  ProjectAdmissionCoordinator,
  type AdmissionCandidate,
} from "../concurrency/concurrency.js";
import { findHigherPriorityQueuedOverlap } from "../scheduler.js";

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
FN-509's admission contract, exercised through the REAL `ProjectAdmissionCoordinator` rather than a
comparator in isolation — the operator's question is "which card actually starts next", and that is
decided by the coordinator's sorted walk plus its reservation/capacity arithmetic.

The cases below deliberately mix lifecycle lanes. Before FN-509 a `review` candidate outranked an
older `execute` or `planning` one; the point of these assertions is that it no longer does.
*/

const PROJECT = "/repo";

const iso = (minutes: number): string => new Date(Date.UTC(2026, 8, 17, 10, minutes, 0)).toISOString();

function candidate(
  taskId: string,
  createdAt: string,
  overrides: Partial<AdmissionCandidate> = {},
): AdmissionCandidate {
  return {
    taskId,
    projectId: PROJECT,
    lane: "execute",
    consumesWorktree: false,
    createdAt,
    column: "todo",
    start: async () => true,
    ...overrides,
  };
}

function boost(sequence: string, overrides: Partial<NonNullable<Task["queueBoost"]>> = {}) {
  return {
    sequence,
    workflowId: "builtin:coding",
    column: "todo",
    columnEntryAt: iso(0),
    requestId: `req-${sequence}`,
    ...overrides,
  };
}

/** A candidate whose stay marker matches the boost record, so the boost is effective. */
function boostedCandidate(taskId: string, createdAt: string, sequence: string, overrides: Partial<AdmissionCandidate> = {}) {
  return candidate(taskId, createdAt, {
    columnMovedAt: iso(0),
    queueBoost: boost(sequence),
    ...overrides,
  });
}

describe("admission ordering — one chronological queue across every lane", () => {
  let coordinator: ProjectAdmissionCoordinator;

  beforeEach(() => {
    coordinator = new ProjectAdmissionCoordinator();
  });

  const admitOne = async (candidates: AdmissionCandidate[], maxConcurrent = 1, claimed = 0) =>
    coordinator.admitNext({
      projectId: PROJECT,
      maxConcurrent,
      claimed: () => claimed,
      refresh: async () => candidates,
    });

  it("starts the OLDEST card when three ages compete, ignoring a reversed legacy priority", async () => {
    // The ages are deliberately opposite to the order a legacy urgent/high/normal rank would give.
    const admitted = await admitOne([
      candidate("FN-30", iso(30), { lane: "review" }),
      candidate("FN-10", iso(10), { lane: "planning" }),
      candidate("FN-20", iso(20)),
    ]);
    expect(admitted).toBe("FN-10");
  });

  it("does not let the review lane overtake an older execute or planning candidate", () => {
    const review = candidate("FN-90", iso(50), { lane: "review" });
    const planning = candidate("FN-01", iso(1), { lane: "planning" });
    expect(compareAdmissionCandidates(planning, review)).toBeLessThan(0);
    expect([review, planning].sort(compareAdmissionCandidates).map((c) => c.taskId)).toEqual(["FN-01", "FN-90"]);
  });

  it("starts the boosted card even when it is the newest of the queue", async () => {
    const admitted = await admitOne([
      candidate("FN-10", iso(10)),
      candidate("FN-20", iso(20)),
      boostedCandidate("FN-30", iso(30), "7"),
    ]);
    expect(admitted).toBe("FN-30");
  });

  it("gives the head to the LAST accepted boost when two cards are boosted", async () => {
    const admitted = await admitOne([
      boostedCandidate("FN-10", iso(10), "5"),
      boostedCandidate("FN-30", iso(30), "6"),
      candidate("FN-01", iso(1)),
    ]);
    expect(admitted).toBe("FN-30");
  });

  it("ignores a boost whose column stay has ended, falling back to arrival order", async () => {
    // The card moved on: `columnMovedAt` no longer matches the boost's `columnEntryAt`.
    const stale = candidate("FN-30", iso(30), { columnMovedAt: iso(45), queueBoost: boost("9") });
    const admitted = await admitOne([stale, candidate("FN-10", iso(10))]);
    expect(admitted).toBe("FN-10");
  });

  it("ignores a boost minted under a different column than the card now sits in", async () => {
    const moved = candidate("FN-30", iso(30), {
      column: "in-progress",
      columnMovedAt: iso(0),
      queueBoost: boost("9"),
    });
    const admitted = await admitOne([moved, candidate("FN-10", iso(10))]);
    expect(admitted).toBe("FN-10");
  });
});

describe("admission ordering — Boost never preempts and never bypasses a gate", () => {
  let coordinator: ProjectAdmissionCoordinator;
  beforeEach(() => {
    coordinator = new ProjectAdmissionCoordinator();
  });

  it("admits nothing while capacity is already fully claimed, even for a boosted card", async () => {
    const start = vi.fn(async () => true);
    const admitted = await coordinator.admitNext({
      projectId: PROJECT,
      maxConcurrent: 1,
      claimed: () => 1,
      refresh: async () => [boostedCandidate("FN-30", iso(30), "7", { start })],
    });
    expect(admitted).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });

  it("starts the boosted card on the very next pass once the slot is released", async () => {
    const candidates = [candidate("FN-10", iso(10)), boostedCandidate("FN-30", iso(30), "7")];
    expect(
      await coordinator.admitNext({ projectId: PROJECT, maxConcurrent: 1, claimed: () => 1, refresh: async () => candidates }),
    ).toBeUndefined();
    expect(
      await coordinator.admitNext({ projectId: PROJECT, maxConcurrent: 1, claimed: () => 0, refresh: async () => candidates }),
    ).toBe("FN-30");
  });

  it("never revokes an already-accepted selection to serve a boost that arrives afterwards", async () => {
    const first = candidate("FN-10", iso(10));
    expect(await coordinator.admitNext({ projectId: PROJECT, maxConcurrent: 1, claimed: () => 0, refresh: async () => [first] })).toBe("FN-10");
    // The winner's reservation is held; a boost landing now cannot take the slot back.
    const admitted = await coordinator.admitNext({
      projectId: PROJECT,
      maxConcurrent: 1,
      claimed: () => 0,
      refresh: async () => [first, boostedCandidate("FN-30", iso(30), "9")],
    });
    expect(admitted).toBeUndefined();
    expect(coordinator.inspectProjectStateForTests(PROJECT).reservedCount).toBe(1);
  });

  it("walks past a candidate whose lane declines the handoff without reordering the rest", async () => {
    const declining = vi.fn(async () => false);
    const admitted = await coordinator.admitNext({
      projectId: PROJECT,
      maxConcurrent: 5,
      claimed: () => 0,
      refresh: async () => [candidate("FN-10", iso(10), { start: declining }), candidate("FN-20", iso(20))],
    });
    expect(declining).toHaveBeenCalledOnce();
    expect(admitted).toBe("FN-20");
    // The refusal released its own reservation; only the real winner holds one.
    expect(coordinator.inspectProjectStateForTests(PROJECT).reservedCount).toBe(1);
  });

  it("lets a worktree-free candidate through while the boosted worktree candidate is gated", async () => {
    const admitted = await coordinator.admitNext({
      projectId: PROJECT,
      maxConcurrent: 5,
      claimed: () => 0,
      worktreeGate: { limit: 1, claimed: () => 1 },
      refresh: async () => [
        boostedCandidate("FN-30", iso(30), "9", { consumesWorktree: true }),
        candidate("FN-40", iso(40), { lane: "planning", consumesWorktree: false }),
      ],
    });
    expect(admitted).toBe("FN-40");
  });

  it("releases its reservation when a lane start throws, leaking no capacity", async () => {
    await expect(
      coordinator.admitNext({
        projectId: PROJECT,
        maxConcurrent: 1,
        claimed: () => 0,
        refresh: async () => [candidate("FN-10", iso(10), { start: async () => { throw new Error("boom"); } })],
      }),
    ).rejects.toThrow("boom");
    expect(coordinator.inspectProjectStateForTests(PROJECT).reservedCount).toBe(0);
  });

  it("keeps a second project's identically-named task out of this project's queue", async () => {
    const admitted = await coordinator.admitNext({
      projectId: PROJECT,
      maxConcurrent: 1,
      claimed: () => 0,
      refresh: async () => [
        candidate("FN-10", iso(0), { projectId: "/other-repo" }),
        candidate("FN-10", iso(20)),
      ],
    });
    expect(admitted).toBe("FN-10");
    expect(coordinator.inspectProjectStateForTests("/other-repo").reservedCount).toBe(0);
  });
});

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
Overlap must defer to the SAME card admission would start next. If the two used different orders a
waiting pair could each decide the other blocks it and neither would ever run.
*/
describe("overlap deferral shares the admission order", () => {
  const scope = ["src/a.ts"];
  const overlaps = (a: string[], b: string[]) => a.some((p) => b.includes(p));

  it("defers to the older overlapping holder", () => {
    const holder = findHigherPriorityQueuedOverlap(
      { id: "FN-30", createdAt: iso(30), column: "todo", scope },
      [{ id: "FN-10", createdAt: iso(10), column: "todo", scope }],
      overlaps,
    );
    expect(holder?.id).toBe("FN-10");
  });

  it("defers to a boosted newer holder", () => {
    const holder = findHigherPriorityQueuedOverlap(
      { id: "FN-10", createdAt: iso(10), column: "todo", scope },
      [{ id: "FN-30", createdAt: iso(30), column: "todo", columnMovedAt: iso(0), queueBoost: boost("4"), scope }],
      overlaps,
    );
    expect(holder?.id).toBe("FN-30");
  });

  it("returns no holder when this card is itself the queue head, so the pair cannot both yield", () => {
    expect(
      findHigherPriorityQueuedOverlap(
        { id: "FN-10", createdAt: iso(10), column: "todo", scope },
        [{ id: "FN-30", createdAt: iso(30), column: "todo", scope }],
        overlaps,
      ),
    ).toBeNull();
  });
});
