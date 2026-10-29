import { describe, expect, it } from "vitest";
import type { Task, WorkflowWorkItem } from "@fusion/core";

import {
  CAPACITY_REFUSAL_DEFER_MS,
  DUE_PLANNING_CONTINUATION_BATCH_LIMIT,
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
  it("stamps the refused head so the next pass reaches the row behind it", async () => {
    const head = planReviewItem("RUFU-805", STALE);
    const behind = planReviewItem("RUFU-811", new Date(PASS_1 - 60 * 3600_000).toISOString());
    const store = dueStore([head, behind]);
    let capacityFree = false;
    const refuseHeadOnly = async (_task: Task, item: WorkflowWorkItem) =>
      capacityFree || item.taskId !== "RUFU-805";

    const firstPass = await runDrain(store, refuseHeadOnly);
    expect(firstPass).toEqual([]);
    expect(store.stamped).toHaveLength(1);
    expect(store.stamped[0]!.itemId).toBe(head.id);
    expect(Date.parse(store.stamped[0]!.retryAfter)).toBe(PASS_1 + CAPACITY_REFUSAL_DEFER_MS);

    // The slot frees while the refused head is still inside its backoff window (the live due poll
    // runs every couple of seconds). The head is therefore not due, so the batch now leads with the
    // row that had been invisible — the rotation the old `break` made impossible.
    capacityFree = true;
    store.setNow(PASS_1 + 2_000);
    const secondPass = await runDrain(store, refuseHeadOnly);
    expect(secondPass).toEqual([behind.id]);
    expect(store.rows.get(head.id)!.state).toBe("runnable");
  });

  it("stamps a refused `retrying` row too, so the whole examined class leaves the due window", async () => {
    const retrying = planReviewItem("RUFU-456", STALE, "retrying");
    const behind = planReviewItem("RUFU-469", new Date(PASS_1 - 3600_000).toISOString());
    const store = dueStore([retrying, behind]);

    await runDrain(store, async (_task, item) => item.taskId !== "RUFU-456");
    expect(store.stamped).toEqual([{
      itemId: retrying.id,
      expectedState: "retrying",
      retryAfter: new Date(PASS_1 + CAPACITY_REFUSAL_DEFER_MS).toISOString(),
    }]);

    store.setNow(PASS_1 + 2_000);
    expect(await runDrain(store, async (_task, item) => item.taskId !== "RUFU-456"))
      .toEqual([behind.id]);
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
