/*
FNXC:HumanMergeApproval 2026-09-17-22:32:
FN-514 P0 remediation — RECOVERY: a decision that is persisted must eventually be executed, and a
card waiting for its operator must never be auto-paused or auto-failed.

Two production owners are asserted here, both of which were missing:

  1. `releaseHumanMergeApprovalHolds` — the graph parks a `held` continuation at the delivery
     barrier, and the continuation drain claims only `runnable`/`retrying` rows. Without a release
     owner, « Merger », « Créer PR » and « Refuser » were persisted and then never executed. The
     release is fenced on the decision identity the hold recorded, so it is simultaneously the
     wake-up after a decision and the crash recovery for a lost wake-up, without ever spinning.

  2. `getInReviewStallReason` / `surfaceInReviewStalls` — a locked card reports a merge BLOCKER, and
     the stall sweep pauses + fails a card that repeats the same blocker `inReviewStallDeadlockThreshold`
     times. With the 10-minute default poll that failed a patient operator's card after ~100 minutes
     and then hid the decision panel, because a paused task reports `blocked`.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHumanMergeHoldMarker,
  describeHumanMergeHoldSignature,
  getInReviewStallReason,
  HUMAN_MERGE_APPROVAL_BLOCKER,
  HUMAN_MERGE_REJECTION_BLOCKER,
  type HumanMergeApprovalState,
  type Task,
  type TaskStore,
} from "@fusion/core";
import { EventEmitter } from "node:events";

import { releaseHumanMergeApprovalHolds } from "../runtimes/in-process-runtime.js";
import { SelfHealingManager } from "../self-healing.js";

const CANDIDATE = {
  lockGeneration: 1,
  workflowSignature: "builtin:coding@7",
  reviewEpisodeId: "2026-09-17T10:00:00.000Z",
  contentSignature: "singular:fp:abc",
  targetSignature: "merge:.@origin:fusion/FN-514->main",
};

const ARMED: HumanMergeApprovalState = { enabled: true, generation: 1 };
const DECIDED_MERGE: HumanMergeApprovalState = {
  enabled: true,
  generation: 1,
  decision: {
    requestId: "r1",
    action: "merge",
    deliveryAction: "merge",
    decidedBy: "dashboard-operator",
    decidedAt: "2026-09-17T11:00:00.000Z",
    candidate: CANDIDATE,
    receipt: { state: "pending", at: "2026-09-17T11:00:00.000Z" },
  },
};
const REJECTED: HumanMergeApprovalState = {
  enabled: true,
  generation: 1,
  remediationGeneration: 1,
  rejection: {
    requestId: "j1",
    instruction: "refais le parcours mobile",
    rejectedBy: "dashboard-operator",
    rejectedAt: "2026-09-17T11:00:00.000Z",
    candidate: CANDIDATE,
    remediationGeneration: 1,
    state: "pending",
  },
};

function makeTask(state: HumanMergeApprovalState | undefined, over: Partial<Task> = {}): Task {
  return {
    id: "FN-514",
    column: "in-review",
    steps: [{ name: "build", status: "done" }],
    workflowStepResults: [],
    worktree: "/tmp/fn-514",
    mergeDetails: {},
    mergeRetries: 0,
    updatedAt: "2026-09-17T10:00:00.000Z",
    log: [],
    humanMergeApproval: state,
    ...over,
  } as unknown as Task;
}

function createHoldStore(task: Task, heldReason: string) {
  const item = {
    id: "wwi-1",
    taskId: task.id,
    kind: "task",
    state: "held",
    leaseOwner: null,
    blockedReason: heldReason,
    updatedAt: "2026-09-17T10:05:00.000Z",
  };
  const transitions: Array<{ id: string; state: string }> = [];
  const store = {
    listDueWorkflowWorkItems: vi.fn(async () => [item]),
    getTask: vi.fn(async () => task),
    transitionWorkflowWorkItem: vi.fn(async (id: string, state: string) => {
      transitions.push({ id, state });
      item.state = state;
      item.blockedReason = null as never;
      return { ...item, state, leaseOwner: null };
    }),
  } as unknown as TaskStore;
  return { store, transitions, item };
}

describe("FN-514 — a persisted decision is eventually executed", () => {
  it("releases the parked hold once the operator's decision changes the durable identity", async () => {
    // The card parked while merely ARMED; the operator has since commanded a merge.
    const parkedSignature = describeHumanMergeHoldSignature(makeTask(ARMED));
    const decided = makeTask(DECIDED_MERGE);
    const { store, transitions } = createHoldStore(decided, buildHumanMergeHoldMarker("", parkedSignature));

    expect(await releaseHumanMergeApprovalHolds(store)).toEqual(["wwi-1"]);
    expect(transitions).toEqual([{ id: "wwi-1", state: "runnable" }]);
  });

  it("releases a hold parked before a rejection was recorded", async () => {
    const parkedSignature = describeHumanMergeHoldSignature(makeTask(ARMED));
    const rejected = makeTask(REJECTED);
    const { store } = createHoldStore(rejected, buildHumanMergeHoldMarker("", parkedSignature));
    expect(await releaseHumanMergeApprovalHolds(store)).toEqual(["wwi-1"]);
  });

  it("releases a hold parked before the operator removed the lock", async () => {
    const parkedSignature = describeHumanMergeHoldSignature(makeTask(ARMED));
    const unlocked = makeTask({ enabled: false, generation: 2 });
    const { store } = createHoldStore(unlocked, buildHumanMergeHoldMarker("", parkedSignature));
    expect(await releaseHumanMergeApprovalHolds(store)).toEqual(["wwi-1"]);
  });

  it("leaves an unchanged hold parked, so a 2-second poll cannot spin the graph", async () => {
    const armed = makeTask(ARMED);
    const { store, transitions } = createHoldStore(armed, buildHumanMergeHoldMarker("", describeHumanMergeHoldSignature(armed)));
    expect(await releaseHumanMergeApprovalHolds(store)).toEqual([]);
    expect(transitions).toEqual([]);
  });

  it("does not re-release a create-pr hold whose receipt already settled", async () => {
    const settled = makeTask({
      ...DECIDED_MERGE,
      decision: {
        ...DECIDED_MERGE.decision!,
        action: "create-pr",
        deliveryAction: "create-pr",
        receipt: { state: "succeeded", at: "t", prNumber: 7, prUrl: "u" },
      },
    });
    const { store, transitions } = createHoldStore(
      settled,
      buildHumanMergeHoldMarker("-pull-request", describeHumanMergeHoldSignature(settled)),
    );
    expect(await releaseHumanMergeApprovalHolds(store)).toEqual([]);
    expect(transitions).toEqual([]);
  });

  it("never releases a paused or deleted card — recovery is not a way around a human stop", async () => {
    const parkedSignature = describeHumanMergeHoldSignature(makeTask(ARMED));
    const paused = makeTask(DECIDED_MERGE, { paused: true } as Partial<Task>);
    expect(await releaseHumanMergeApprovalHolds(
      createHoldStore(paused, buildHumanMergeHoldMarker("", parkedSignature)).store,
    )).toEqual([]);

    const deleted = makeTask(DECIDED_MERGE, { deletedAt: "2026-09-17T12:00:00.000Z" } as Partial<Task>);
    expect(await releaseHumanMergeApprovalHolds(
      createHoldStore(deleted, buildHumanMergeHoldMarker("", parkedSignature)).store,
    )).toEqual([]);
  });

  it("ignores holds belonging to other marker families", async () => {
    const decided = makeTask(DECIDED_MERGE);
    const { store, transitions } = createHoldStore(decided, "workflow-principal-role-pool-exhausted:triage");
    expect(await releaseHumanMergeApprovalHolds(store)).toEqual([]);
    expect(transitions).toEqual([]);
  });

  it("releases a legacy hold that carries no recorded identity, exactly once", async () => {
    const decided = makeTask(DECIDED_MERGE);
    const { store } = createHoldStore(decided, "workflow-human-merge-approval");
    expect(await releaseHumanMergeApprovalHolds(store)).toEqual(["wwi-1"]);
  });
});

/** The stall-sweep store double, shaped like the existing reliability-interaction fixtures. */
function createStallStore(task: Task, settings: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  const audits: Array<Record<string, unknown>> = [];
  (emitter as never as Record<string, unknown>).__audits = audits;
  Object.assign(emitter as never as Record<string, unknown>, {
    getSettings: vi.fn().mockResolvedValue({
      autoMerge: true,
      globalPause: false,
      enginePaused: false,
      taskStuckTimeoutMs: 60_000,
      inReviewStallDeadlockThreshold: 3,
      ...settings,
    }),
    listTasks: vi.fn(async () => [task]),
    logEntry: vi.fn(async (_taskId: string, action: string) => {
      task.log = task.log ?? [];
      task.log.push({ timestamp: new Date(Date.now()).toISOString(), action });
    }),
    updateTask: vi.fn(async (_taskId: string, updates: Partial<Task>) => {
      Object.assign(task, updates);
    }),
    applyInReviewStallObservationFenced: vi.fn(async (_taskId: string, compute: (current: Task) => Record<string, unknown> | null) => {
      const patch = compute(task);
      if (!patch) return { applied: false, reason: "refused" };
      const { logEntry, ...fields } = patch;
      task.log = task.log ?? [];
      task.log.push(logEntry as never);
      Object.assign(task, fields);
      return { applied: true, task };
    }),
    recordRunAuditEvent: vi.fn(async (event: Record<string, unknown>) => { audits.push(event); }),
    moveTask: vi.fn(async () => undefined),
    enqueueMergeQueue: vi.fn(async () => undefined),
  });
  return emitter;
}

describe("FN-514 — a card waiting for its operator is not a stall", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("classifies neither an awaited decision nor an owed correction as a stall signal", () => {
    expect(getInReviewStallReason(makeTask(ARMED))).toBeUndefined();
    expect(getInReviewStallReason(makeTask(REJECTED))).toBeUndefined();
    // The create-pr transfer hold reports the same blocker and is equally exempt.
    expect(getInReviewStallReason(makeTask({
      ...DECIDED_MERGE,
      decision: { ...DECIDED_MERGE.decision!, action: "create-pr", deliveryAction: "create-pr" },
    }))).toBeUndefined();
  });

  it("still reports genuine stalls, so the exemption is narrow", () => {
    const stalled = makeTask(undefined, { worktree: undefined } as Partial<Task>);
    expect(getInReviewStallReason(stalled)?.code).toBe("no-worktree-no-merge-confirmed");
  });

  it("does not pause or fail a locked card past the deadlock threshold", async () => {
    const task = makeTask(ARMED);
    const store = createStallStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    // Far beyond `inReviewStallDeadlockThreshold` passes: patience is not a deadlock.
    for (let minute = 10; minute <= 120; minute += 10) {
      vi.setSystemTime(new Date(`2026-09-17T${String(10 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`));
      expect(await manager.surfaceInReviewStalls()).toBe(0);
    }

    expect(task.paused).toBeUndefined();
    expect(task.status).toBeUndefined();
    expect((task.log ?? []).filter((entry) => entry.action.includes("In-review stall"))).toEqual([]);
    expect((store as never as { __audits: unknown[] }).__audits).toEqual([]);
  });

  it("does not pause or fail a card whose rejection still owes corrections", async () => {
    const task = makeTask(REJECTED);
    const store = createStallStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    for (let minute = 10; minute <= 120; minute += 10) {
      vi.setSystemTime(new Date(`2026-09-17T${String(10 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`));
      expect(await manager.surfaceInReviewStalls()).toBe(0);
    }

    expect(task.paused).toBeUndefined();
    expect(task.status).toBeUndefined();
  });

  it("keeps the door itself closed — the exemption is about the sweep, not about merging", async () => {
    const { getTaskMergeBlocker } = await import("@fusion/core");
    expect(getTaskMergeBlocker(makeTask(ARMED))).toBe(HUMAN_MERGE_APPROVAL_BLOCKER);
    expect(getTaskMergeBlocker(makeTask(REJECTED))).toBe(HUMAN_MERGE_REJECTION_BLOCKER);
  });
});
