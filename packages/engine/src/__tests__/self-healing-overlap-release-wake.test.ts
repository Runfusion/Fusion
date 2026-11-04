import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";

/*
FNXC:OverlapWaitSynchronization 2026-09-18-01:20:
Covers the self-healing side of FN-329's "release the file-scope wait wake, not just the display
marker" contract, reimplemented for a branch that had excluded it. Three independent sweeps clear
`task.overlapBlockedBy` for a holder that died/went terminal without ever publishing a normal
overlap-wait release: completion fan-out (reconcileCompletedTask), the periodic stale-blockedBy
sweep (clearStaleBlockedBy), and the dependency-blocking-lease deadlock breaker
(reconcileDependencyBlockingLeases). Each must invoke `options.onOverlapBlockersReleased` with
exactly the (taskId, blockerId) pairs it actually committed — never for a preserved/queued wait,
never before the durable clear lands.
*/

const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn(() => false) }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSyncMock };
});

const { logger } = vi.hoisted(() => ({
  logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../logger.js", () => ({ createLogger: vi.fn(() => logger) }));

import { SelfHealingManager } from "../self-healing.js";
import { reconcileReleasedOverlapWaits } from "../self-healing/released-overlap-waits.js";
import { OVERLAP_DELIVERY_UNAVAILABLE_ERROR } from "@fusion/core";

const NOW_ISO = "2026-09-18T00:00:00.000Z";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    status: null,
    paused: false,
    blockedBy: null,
    overlapBlockedBy: null,
    dependencies: [],
    steps: [],
    log: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  } as Task;
}

function makeStore(tasksInput: Task[], settingsOverrides: Partial<Settings> = {}): { tasks: Map<string, Task>; store: TaskStore & EventEmitter } {
  const tasks = new Map(tasksInput.map((task) => [task.id, task]));
  const emitter = new EventEmitter();
  /*
  FNXC:OverlapWaitSynchronization 2026-10-09-16:10 (RUFU-330):
  Overlap grouping is the PRECONDITION these three sweeps have anything to release, so the shared
  fixture states it. Production treats an absent `groupOverlappingFiles` as "the feature is off, so any
  surviving `overlapBlockedBy` is stale by definition" and clears it unconditionally
  (`canClearObservedOverlap` returns the setting's own absence, and `resolveFreshDependentOverlap`
  short-circuits on `groupOverlappingFiles === true`). A fixture that left the flag unset therefore
  proved the opposite of its test name: the "still active holder" case woke its dependent because the
  board never asked whether the holder was active, not because preservation is broken. Declared here
  once so every case in this file exercises the real lifetime decision, and the terminal-holder case
  keeps releasing for the right reason (a terminal lane surrenders its lease), not because grouping was off.
  */
  const settings: Settings = { globalPause: false, enginePaused: false, groupOverlappingFiles: true, ...settingsOverrides } as Settings;
  const store = Object.assign(emitter, {
    /* FNXC:WorkflowBatchCacheEpoch 2026-10-12-23:00 (RUFU-584 fixture repair): same gap as
       `self-healing-stale-overlap-blocker.test.ts` — the shared IR cache now reads the definition epoch
       unguarded, so an absent method threw the sweep out before its first decision. See that note. */
    workflowDefinitionEpoch: () => 0,
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async (opts?: { column?: Task["column"]; includeArchived?: boolean }) => {
      const all = [...tasks.values()];
      if (!opts?.column) return all;
      return all.filter((t) => t.column === opts.column);
    }),
    getTask: vi.fn(async (id: string) => tasks.get(id) ?? null),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`missing ${id}`);
      const next = { ...current, ...patch } as Task;
      if (patch.overlapBlockedBy === null) next.overlapBlockedBy = undefined;
      tasks.set(id, next);
      return next;
    }),
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`missing ${id}`);
      const next = { ...current, column } as Task;
      tasks.set(id, next);
      return next;
    }),
    transitionQueuedEpisode: vi.fn(async (id: string, transition: { signature: string; blockedBy: string | null; overlapBlockedBy: string | null; action: string }) => {
      const current = tasks.get(id)!;
      const appended = !(current.status === "queued"
        && (current.blockedBy ?? null) === transition.blockedBy
        && (current.overlapBlockedBy ?? null) === transition.overlapBlockedBy);
      const next = { ...current, status: "queued", blockedBy: transition.blockedBy, overlapBlockedBy: transition.overlapBlockedBy } as Task;
      tasks.set(id, next);
      return { appended, task: next };
    }),
    logEntry: vi.fn(async () => undefined),
    parseFileScopeFromPrompt: vi.fn(async () => ["packages/engine/src/self-healing.ts"]),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
  return { tasks, store };
}

describe("self-healing overlap-wait release wake", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reconcileCompletedTask wakes the exact dependent whose overlap blocker it cleared, and only that one", async () => {
    const blocker = makeTask("FN-B", { column: "done" });
    const dependent = makeTask("FN-WAITING", { column: "todo", status: "queued", overlapBlockedBy: "FN-B" });
    const unrelated = makeTask("FN-UNRELATED", { column: "todo" });
    const { store } = makeStore([blocker, dependent, unrelated]);
    const onOverlapBlockersReleased = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", onOverlapBlockersReleased });

    await manager.reconcileCompletedTask("FN-B");

    expect(onOverlapBlockersReleased).toHaveBeenCalledTimes(1);
    expect(onOverlapBlockersReleased).toHaveBeenCalledWith([{ taskId: "FN-WAITING", blockerId: "FN-B" }]);
  });

  it("reconcileCompletedTask does not wake anything when no dependent was overlap-blocked", async () => {
    const blocker = makeTask("FN-B", { column: "done" });
    const dependent = makeTask("FN-DEP", { column: "todo", blockedBy: "FN-B", dependencies: ["FN-B"] });
    const { store } = makeStore([blocker, dependent]);
    const onOverlapBlockersReleased = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", onOverlapBlockersReleased });

    await manager.reconcileCompletedTask("FN-B");

    expect(onOverlapBlockersReleased).not.toHaveBeenCalled();
  });

  it("reconcileCompletedTask tolerates a throwing/rejecting release callback without affecting its own result", async () => {
    const blocker = makeTask("FN-B", { column: "done" });
    const dependent = makeTask("FN-WAITING", { column: "todo", status: "queued", overlapBlockedBy: "FN-B" });
    const { store, tasks } = makeStore([blocker, dependent]);
    const onOverlapBlockersReleased = vi.fn(async () => { throw new Error("wake sink down"); });
    const manager = new SelfHealingManager(store, { rootDir: "/repo", onOverlapBlockersReleased });

    const result = await manager.reconcileCompletedTask("FN-B");

    expect(result.blockedByCleared).toBe(1);
    expect(tasks.get("FN-WAITING")?.overlapBlockedBy).toBeUndefined();
    expect(onOverlapBlockersReleased).toHaveBeenCalledTimes(1);
  });

  it("clearStaleBlockedBy wakes a dependent once its terminal holder's stale overlap marker is cleared", async () => {
    const holder = makeTask("FN-HOLDER", { column: "done" });
    const dependent = makeTask("FN-DEPENDENT", { column: "todo", status: "queued", overlapBlockedBy: "FN-HOLDER" });
    const { store, tasks } = makeStore([holder, dependent]);
    const onOverlapBlockersReleased = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", onOverlapBlockersReleased });

    // FN-5434: this specific "queued overlap wait, blocker now inactive" cleanup is
    // deliberately silent (no `recovered` increment) — assert the state change and the release
    // wake, not the counter.
    await manager.clearStaleBlockedBy();

    expect(tasks.get("FN-DEPENDENT")).toMatchObject({ overlapBlockedBy: undefined, status: null });
    expect(onOverlapBlockersReleased).toHaveBeenCalledWith([{ taskId: "FN-DEPENDENT", blockerId: "FN-HOLDER" }]);
  });

  it("clearStaleBlockedBy does not wake anything while the overlap blocker is preserved (still active)", async () => {
    const holder = makeTask("FN-HOLDER", { column: "in-progress", worktree: "/wt/fn-holder" });
    const dependent = makeTask("FN-DEPENDENT", {
      column: "todo", status: "queued", overlapBlockedBy: "FN-HOLDER", blockedBy: "FN-HOLDER", dependencies: ["FN-HOLDER"],
    });
    const { store } = makeStore([holder, dependent]);
    const onOverlapBlockersReleased = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", onOverlapBlockersReleased });

    await manager.clearStaleBlockedBy();

    expect(onOverlapBlockersReleased).not.toHaveBeenCalled();
  });
});

/*
FNXC:OverlapWaitRelease 2026-11-04-00:55 (RUFU-373):
The wake half of the delivered-file-evidence wedge. Two independent gaps kept a parked card frozen:

1. `isRecoverableOverlapWaitFailure` exact-matched the BARE sentence, so every row the acquisition cap
   had already wrapped (`Worktree acquisition failed after N heartbeat attempts for branch "...": …`)
   — including SANE-436's live row — was invisible to both resume authorities.
2. The sweep's `resumeIf` accepted only the WIP lane, while the bounded park lands in the workflow's
   rebound/Hold dwell lane. That lane's column id is literally `todo` in the builtin coding boards
   (its name is "Planning") and something else entirely on a custom board, so lane membership must be
   derived from traits — Hold is non-unique, so membership comes from `columnsWithFlag`, never from
   `lanes.hold` first-match, and never from a hard-coded id.
*/
import { overlapWaitResumeLaneIds } from "../self-healing/released-overlap-waits.js";
import { isRecoverableOverlapWaitFailure, OVERLAP_DELIVERY_UNAVAILABLE_ERROR } from "@fusion/core";
import type { LifecycleColumns, WorkflowIr } from "@fusion/core";

describe("overlap-wait resume lane authority is trait-derived", () => {
  const ir = (columns: Array<{ id: string; traits: string[] }>) => ({
    version: "v2",
    id: "custom:wf",
    nodes: [],
    edges: [],
    columns: columns.map((c) => ({ id: c.id, name: c.id, traits: c.traits.map((trait) => ({ trait })) })),
  }) as unknown as WorkflowIr;

  const builtinShaped = ir([
    { id: "triage", traits: ["intake"] },
    { id: "todo", traits: ["hold"] },
    { id: "in-progress", traits: ["wip"] },
    { id: "in-review", traits: ["merge", "human-review"] },
    { id: "done", traits: ["complete"] },
  ]);
  const lanesOf = (pick: Record<string, string | undefined>) =>
    ({ intake: pick.intake, hold: pick.hold, wip: pick.wip, review: pick.review, complete: pick.complete }) as LifecycleColumns;

  it("accepts the dwell lane whose id is `todo` on a builtin-coding-shaped board, and rejects review/complete", () => {
    const lanes = lanesOf({ intake: "triage", hold: "todo", wip: "in-progress", review: "in-review", complete: "done" });
    const accepted = overlapWaitResumeLaneIds(lanes, builtinShaped);

    expect(accepted.has("in-progress")).toBe(true);
    expect(accepted.has("todo")).toBe(true);
    expect(accepted.has("triage")).toBe(true);
    // Review and complete lanes must never gain resume authority from this sweep.
    expect(accepted.has("in-review")).toBe(false);
    expect(accepted.has("done")).toBe(false);
  });

  it("accepts a dwell column whose id is NOT `todo`, proving trait derivation rather than id matching", () => {
    const custom = ir([
      { id: "inbox", traits: ["intake"] },
      { id: "drafting", traits: ["hold"] },
      { id: "building", traits: ["wip"] },
      { id: "reviewing", traits: ["merge"] },
      { id: "shipped", traits: ["complete"] },
    ]);
    const lanes = lanesOf({ intake: "inbox", hold: "drafting", wip: "building", review: "reviewing", complete: "shipped" });
    const accepted = overlapWaitResumeLaneIds(lanes, custom);

    expect(accepted.has("drafting")).toBe(true);
    expect(accepted.has("building")).toBe(true);
    expect(accepted.has("inbox")).toBe(true);
    expect(accepted.has("reviewing")).toBe(false);
    expect(accepted.has("shipped")).toBe(false);
    // The builtin literal must not be recognised on a board that never declares it.
    expect(accepted.has("todo")).toBe(false);
  });

  it("accepts every dwell column when a board declares two Hold lanes", () => {
    const twoHolds = ir([
      { id: "intake", traits: ["intake"] },
      { id: "hold-a", traits: ["hold"] },
      { id: "hold-b", traits: ["hold"] },
      { id: "wip", traits: ["wip"] },
      { id: "review", traits: ["merge"] },
      { id: "done", traits: ["complete"] },
    ]);
    // `lanes.hold` is FIRST-match by signature, so a single-id comparison would under-cover hold-b.
    const lanes = lanesOf({ intake: "intake", hold: "hold-a", wip: "wip", review: "review", complete: "done" });
    const accepted = overlapWaitResumeLaneIds(lanes, twoHolds);

    expect(accepted.has("hold-a")).toBe(true);
    expect(accepted.has("hold-b")).toBe(true);
  });

  it("resumes nothing when the workflow vocabulary is unresolvable", () => {
    expect(overlapWaitResumeLaneIds(lanesOf({}), undefined).size).toBe(0);
  });
});

describe("recoverability of a wrapped acquisition-exhaustion overlap failure", () => {
  const EXHAUSTION_PREFIX = "Worktree acquisition failed after 3 heartbeat attempts for branch ";
  const SANE_436_MESSAGE = `${EXHAUSTION_PREFIX}"fusion/sane-436": ${OVERLAP_DELIVERY_UNAVAILABLE_ERROR}`;

  it("recognises the literal SANE-436 composed message so an already-wedged row self-heals", () => {
    expect(isRecoverableOverlapWaitFailure(SANE_436_MESSAGE)).toBe(true);
  });

  it("recognises a wrapped episode-superseded sentence", () => {
    const wrapped = `${EXHAUSTION_PREFIX}"fusion/x-1": Overlap synchronization episode ep-7 changed before claim`;
    expect(isRecoverableOverlapWaitFailure(wrapped)).toBe(true);
  });

  it("keeps a non-overlap composed exhaustion message non-recoverable", () => {
    expect(isRecoverableOverlapWaitFailure(`${EXHAUSTION_PREFIX}"fusion/x-2": fatal: not a git repository`)).toBe(false);
    expect(isRecoverableOverlapWaitFailure(`${EXHAUSTION_PREFIX}"fusion/x-3": TASK_BASE_DIVERGED from its remote-tracking counterpart`)).toBe(false);
  });

  it("keeps the bare sentence and the plain superseded sentence recoverable", () => {
    expect(isRecoverableOverlapWaitFailure(OVERLAP_DELIVERY_UNAVAILABLE_ERROR)).toBe(true);
    expect(isRecoverableOverlapWaitFailure("Overlap synchronization episode ep-1 changed before publication")).toBe(true);
    expect(isRecoverableOverlapWaitFailure(null)).toBe(false);
    expect(isRecoverableOverlapWaitFailure("unrelated failure")).toBe(false);
  });
});

/*
FNXC:OverlapWaitRelease 2026-11-04-02:35 (RUFU-373):
The sweep's own resume gate, driven end-to-end. Before this the gate had NO test at all, which is how
`current.column === lanes?.wip` survived while the bounded acquisition park lands in the workflow's
Hold/dwell lane: a card waiting in `drafting` was examined, refused, and never examined again — even after
its predecessor had landed and the wait was provably over.

The board here is deliberately NOT builtin-shaped: its Hold lane is `drafting` and its WIP lane is
`building`, so a pass can only be explained by trait derivation. The error text is the literal message
SANE-436 carried, which the acquisition cap had already composed — the wrapped shape is part of the bug.
*/
describe("released-overlap-waits resume gate", () => {
  const boardIr = {
    version: "v2",
    id: "custom:board",
    name: "Board",
    nodes: [
      { id: "start", kind: "start", column: "inbox" },
      { id: "plan", kind: "prompt", column: "drafting" },
      { id: "code", kind: "prompt", column: "building" },
      { id: "end", kind: "end", column: "shipped" },
    ],
    edges: [
      { from: "start", to: "plan" },
      { from: "plan", to: "code" },
      { from: "code", to: "end" },
    ],
    columns: [
      { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
      { id: "drafting", name: "Drafting", traits: [{ trait: "hold" }] },
      { id: "building", name: "Building", traits: [{ trait: "wip" }] },
      { id: "reviewing", name: "Reviewing", traits: [{ trait: "merge" }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
  };
  const SANE_436_ERROR = `Worktree acquisition failed after 3 heartbeat attempts for branch "fusion/sane-436": ${OVERLAP_DELIVERY_UNAVAILABLE_ERROR}`;

  function sweepStore(task: Task) {
    const resumeIfSeen: Array<(current: Task) => boolean> = [];
    const store = {
      getSettings: async () => ({ globalPause: false, enginePaused: false }),
      listTasks: async () => [task],
      getTaskWorkflowSelection: () => ({ workflowId: "custom:board" }),
      getTaskWorkflowSelectionAsync: async () => ({ workflowId: "custom:board" }),
      getWorkflowDefinition: async () => ({ ir: JSON.stringify(boardIr) }),
      reconcileTaskOverlapWaits: vi.fn(async (_taskId: string, options: { resumeIf: (current: Task) => boolean }) => {
        resumeIfSeen.push(options.resumeIf);
        return { cancelledCount: 0, resumed: options.resumeIf(task), clearedBlockerIds: [] };
      }),
    } as unknown as TaskStore;
    return { store, resumeIfSeen };
  }

  function parkedTask(column: string) {
    return makeTask("SANE-436", {
      column, status: "failed", error: SANE_436_ERROR, branch: "fusion/sane-436", worktree: null,
      checkedOutBy: null, paused: false, userPaused: false, autoMerge: true,
    });
  }

  it("resumes a wait parked in a Hold dwell lane whose id is not `todo`", async () => {
    const { store, resumeIfSeen } = sweepStore(parkedTask("drafting"));
    expect(await reconcileReleasedOverlapWaits(store, () => false)).toBe(1);
    expect(resumeIfSeen).toHaveLength(1);
  });

  it("still resumes the WIP lane it always covered", async () => {
    const { store } = sweepStore(parkedTask("building"));
    expect(await reconcileReleasedOverlapWaits(store, () => false)).toBe(1);
  });

  it("gains no resume authority over the review lane from this sweep", async () => {
    const { store, resumeIfSeen } = sweepStore(parkedTask("reviewing"));
    expect(await reconcileReleasedOverlapWaits(store, () => false)).toBe(0);
    // The card WAS examined — the refusal is the lane gate, not a candidate filter that never looked.
    expect(resumeIfSeen).toHaveLength(1);
  });

  it("gains no resume authority over the terminal lane from this sweep", async () => {
    const { store, resumeIfSeen } = sweepStore(parkedTask("shipped"));
    expect(await reconcileReleasedOverlapWaits(store, () => false)).toBe(0);
    expect(resumeIfSeen).toHaveLength(1);
  });

  it("never resumes a card a live session still owns, even in an accepted lane", async () => {
    const { store } = sweepStore(parkedTask("drafting"));
    expect(await reconcileReleasedOverlapWaits(store, () => true)).toBe(0);
  });
});
