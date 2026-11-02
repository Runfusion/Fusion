import { describe, expect, it } from "vitest";
import type { Task, WorkflowWorkItem } from "@fusion/core";

import {
  CAPACITY_REFUSAL_DEFER_MS,
  DUE_PLANNING_CONTINUATION_BATCH_LIMIT,
  WORKFLOW_CONTINUATION_POLL_MS,
  drainDuePlanningContinuations,
} from "../runtimes/in-process-runtime.js";

/*
FNXC:ContinuationDrainFairness 2026-10-29-10:55 (RUFU-812):
The due poll reads `DUE_PLANNING_CONTINUATION_BATCH_LIMIT` rows ordered by task queue rank, so the
window only advances when an examined row leaves the due set. A capacity refusal examined a row and
wrote nothing, so the same head row was re-listed and re-refused every pass: measured on the live
board, 156 due continuations with zero `retryAfter`, 95 of them `plan-review`, oldest 81 days, and
zero board moves in 30 minutes.
These tests hold the invariant across the whole examined/not-moved class rather than the single
reported card, and they prove rotation through a fake due filter (the same `retryAfter <= now`
predicate the store applies) instead of asserting that a callback fired.
*/

const PASS_1 = Date.parse("2026-10-29T10:00:00.000Z");
const STALE = new Date(PASS_1 - 81 * 24 * 3600_000).toISOString();

function task(id: string): Task {
  return {
    id,
    title: `Starved continuation ${id}`,
    description: "Armed Plan Review continuation that no drain ever read",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: STALE,
    updatedAt: STALE,
  } as Task;
}

function planReviewItem(taskId: string, createdAt: string, state: "runnable" | "retrying" = "runnable"): WorkflowWorkItem {
  return {
    id: `wi-${taskId}`,
    runId: `run-${taskId}`,
    taskId,
    nodeId: "plan-review",
    nodeInstanceId: "plan-review",
    kind: "task",
    state,
    attempt: 0,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    blockedReason: null,
    waitReason: "planning",
    createdAt,
    updatedAt: STALE,
  } as WorkflowWorkItem;
}

/** Mirrors `listDueWorkflowWorkItems`: due means a past `retryAfter` and an expired lease, and the
 *  set is ordered so the queue-rank head is the batch that gets read. */
function dueStore(items: WorkflowWorkItem[], limit = DUE_PLANNING_CONTINUATION_BATCH_LIMIT) {
  const rows = new Map(items.map((item) => [item.id, { ...item }]));
  const stamped: Array<{ itemId: string; expectedState: string; retryAfter: string }> = [];
  let nowMs = PASS_1;
  return {
    rows,
    stamped,
    setNow(value: number) {
      nowMs = value;
    },
    listDue: async () =>
      [...rows.values()]
        .filter((row) => (row.state === "runnable" || row.state === "retrying")
          && (row.retryAfter === null || Date.parse(row.retryAfter) <= nowMs)
          && (row.leaseExpiresAt === null || Date.parse(row.leaseExpiresAt) <= nowMs))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .slice(0, limit)
        .map((row) => ({ ...row })),
    getTask: async (taskId: string) => task(taskId),
    /** The runtime's deferral is a compare-and-set on the listed state. */
    defer: async ({ itemId, expectedState, retryAfter }: { itemId: string; expectedState: string; retryAfter: string }) => {
      const row = rows.get(itemId);
      if (!row || row.state !== expectedState) return;
      row.retryAfter = retryAfter;
      stamped.push({ itemId, expectedState, retryAfter });
    },
    cancelOrphan: async () => undefined,
    nowMs: () => nowMs,
    warn: () => undefined,
  };
}

function runDrain(store: ReturnType<typeof dueStore>, dispatch: (task: Task, item: WorkflowWorkItem) => Promise<boolean>) {
  const dispatched: string[] = [];
  return drainDuePlanningContinuations({
    listDue: store.listDue,
    getTask: store.getTask,
    resolveTerminalColumns: async () => new Set(["done"]),
    isPlannerLive: () => false,
    cancelOrphan: store.cancelOrphan,
    defer: store.defer,
    dispatch: async (taskArg, item) => {
      const accepted = await dispatch(taskArg, item);
      if (accepted) dispatched.push(item.id);
      return accepted;
    },
    nowMs: store.nowMs,
    warn: () => undefined,
  }).then(() => dispatched);
}

describe("a capacity-refused continuation cannot starve the rest of the due window", () => {
  it("stamps every row the shared cap refused, not only the head it reached first", async () => {
    const head = planReviewItem("RUFU-805", STALE);
    const behind = planReviewItem("RUFU-811", new Date(PASS_1 - 60 * 3600_000).toISOString());
    const store = dueStore([head, behind]);

    /*
    FNXC:ContinuationDrainFairness 2026-11-02-20:12 (RUFU-862):
    The old version of this case refused ONLY the head and accepted the row behind it. That shape is
    not reachable: `deps.dispatch` is documented as "return false when SHARED capacity rejected this
    item; later FIFO items cannot fit either", and `admitPlanningContinuation` has a single `return
    false` reached only when the shared admission coordinator declined. A per-card fake refusal
    predicate therefore tested a state the runtime cannot produce, and it pinned one-stamp-per-pass -
    the exact behaviour that starves the queue: rotating a 20-wide window by one row per 2 s poll
    needs 269 passes, while the stamp expired after 5 s.
    */
    const firstPass = await runDrain(store, async () => false);
    expect(firstPass).toEqual([]);
    expect(store.stamped.map((s) => s.itemId)).toEqual([head.id, behind.id]);
    expect(Date.parse(store.stamped[0]!.retryAfter)).toBe(PASS_1 + CAPACITY_REFUSAL_DEFER_MS);
    // Deferral is a fairness move: neither row changed state, so no lane loses a claim.
    expect(store.rows.get(head.id)!.state).toBe("runnable");
    expect(store.rows.get(behind.id)!.state).toBe("runnable");

    // When capacity frees the rows come back: a deferral is not a hold.
    store.setNow(PASS_1 + CAPACITY_REFUSAL_DEFER_MS + 1);
    expect(await runDrain(store, async () => true)).toEqual([head.id, behind.id]);
  });

  it("rotates the window within one horizon so a row ranked below the batch limit is examined", async () => {
    /*
    FNXC:ContinuationDrainFairness 2026-11-02-20:12 (RUFU-862):
    The defect this exists for: 269 due rows in one project, 20 inside the batch, 14 of the 269
    carrying any `retryAfter` at all four days after the stamp shipped, and RUFU-627 ranked 98th -
    never read, with `capacity_refused=0` and a free worktree.

    Rotation lives INSIDE the horizon: a deferred row is invisible only while its stamp is live, so
    the pass that must reach rank 21 is the next poll (2 s later), not a poll after the horizon. An
    earlier draft of this test advanced past the horizon and correctly failed - the window had simply
    refilled with the same head.
    */
    const rows = Array.from({ length: DUE_PLANNING_CONTINUATION_BATCH_LIMIT + 2 }, (_, index) =>
      planReviewItem(`RUFU-${1000 + index}`, new Date(PASS_1 - (100 - index) * 3600_000).toISOString()),
    );
    const outsideWindow = rows[DUE_PLANNING_CONTINUATION_BATCH_LIMIT]!;
    const store = dueStore(rows);

    const firstPass = await runDrain(store, async () => false);
    expect(firstPass).toEqual([]);
    expect(store.stamped).toHaveLength(DUE_PLANNING_CONTINUATION_BATCH_LIMIT);
    expect(store.stamped.map((s) => s.itemId)).not.toContain(outsideWindow.id);

    // Next poll, still inside the horizon: the whole previous window is deferred, so the batch must
    // now lead with the rows that had never been read. With one stamp per pass this never happens.
    store.setNow(PASS_1 + WORKFLOW_CONTINUATION_POLL_MS);
    const secondPass = await runDrain(store, async () => false);
    expect(secondPass).toEqual([]);
    expect(store.stamped.map((s) => s.itemId)).toContain(outsideWindow.id);
  });

  it("keeps the refusal horizon longer than one rotation of the measured due set", () => {
    /*
    FNXC:ContinuationDrainFairness 2026-11-02-20:12 (RUFU-862):
    The arithmetic RUFU-812's comment got wrong, in the only form that cannot drift: it sized a full
    rotation as `ceil(156 / 20) = 8 passes` while the code stamped ONE row per pass, so a rotation cost
    `N` polls and the 5 s horizon was ~40x too short. With one pass vacating the whole window, the tail
    is reachable only while the earliest stamp is still live, which is this inequality. The row count is
    the measured production due set, so the invariant fails loudly if the board grows past the horizon.
    */
    const measuredDueRowsRunFusion = 269;
    const passesPerRotation = Math.ceil(measuredDueRowsRunFusion / DUE_PLANNING_CONTINUATION_BATCH_LIMIT);
    expect(CAPACITY_REFUSAL_DEFER_MS)
      .toBeGreaterThan(passesPerRotation * WORKFLOW_CONTINUATION_POLL_MS);
  });

  it("stamps a refused `retrying` row too, so the whole examined class leaves the due window", async () => {
    const retrying = planReviewItem("RUFU-456", STALE, "retrying");
    const behind = planReviewItem("RUFU-469", new Date(PASS_1 - 3600_000).toISOString());
    const store = dueStore([retrying, behind]);

    // Shared-capacity refusal: the whole examined class must leave the window, `retrying` included.
    await runDrain(store, async () => false);
    expect(store.stamped).toEqual([
      {
        itemId: retrying.id,
        expectedState: "retrying",
        retryAfter: new Date(PASS_1 + CAPACITY_REFUSAL_DEFER_MS).toISOString(),
      },
      {
        itemId: behind.id,
        expectedState: "runnable",
        retryAfter: new Date(PASS_1 + CAPACITY_REFUSAL_DEFER_MS).toISOString(),
      },
    ]);

    store.setNow(PASS_1 + CAPACITY_REFUSAL_DEFER_MS + 1);
    expect(await runDrain(store, async () => true)).toEqual([retrying.id, behind.id]);
  });

  it("does not stamp a row another lane already moved", async () => {
    const head = planReviewItem("RUFU-812", STALE);
    const store = dueStore([head]);
    // The due poll returned a `runnable` snapshot; a planner claimed it before the stamp landed.
    const listed = await store.listDue();
    store.rows.get(head.id)!.state = "running";
    store.rows.get(head.id)!.leaseOwner = "triage:RUFU-812:run";

    await drainDuePlanningContinuations({
      listDue: async () => listed,
      getTask: store.getTask,
      resolveTerminalColumns: async () => new Set(["done"]),
      isPlannerLive: () => false,
      cancelOrphan: store.cancelOrphan,
      defer: store.defer,
      dispatch: async () => false,
      nowMs: store.nowMs,
      warn: () => undefined,
    });

    expect(store.stamped).toEqual([]);
    expect(store.rows.get(head.id)!.retryAfter).toBeNull();
  });

  it("writes no deferral when admission accepts the item", async () => {
    const only = planReviewItem("RUFU-805", STALE);
    const store = dueStore([only]);

    expect(await runDrain(store, async () => true)).toEqual([only.id]);
    expect(store.stamped).toEqual([]);
    expect(store.rows.get(only.id)!.retryAfter).toBeNull();
  });
});
