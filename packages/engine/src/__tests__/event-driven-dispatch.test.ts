import "./executor-test-helpers.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowWorkItem } from "@fusion/core";

import {
  clearPreHeldExecutorSlotsForTests,
  projectAdmissionCoordinator,
  registerPreHeldExecutorSlot,
  releasePreHeldAdmissionReservation,
} from "../concurrency/concurrency.js";
import { planLog } from "../logger.js";
import { TriageProcessor } from "../triage.js";
import { wakePlannerLiveDeferredContinuations } from "../runtimes/in-process-runtime.js";
import { resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:EventDrivenDispatch 2026-09-18-00:40:
FN-519 regression home for « action → réaction ». Every case here asserts that an admissible card
reaches its owning pass WITHOUT advancing a fake clock: the only settling primitive is a microtask
flush, so a test that needs `advanceTimersByTime` to pass is proving the periodic backstop instead
of the event path. The four reproductions map to the task's Symptom Verification A–D:

A. a bootstrap card landing in its planning lane starts planning discovery immediately
   (previously delayed a deliberate 150 ms by TriageProcessor.NUDGE_DEBOUNCE_MS);
B. a Plan Review continuation deferred by `planner-live` is released once the planner that caused
   the deferral is actually gone (previously it kept a +15 s `retryAfter` and left the due window);
C. finishing implementation / releasing a planning owner wakes the continuation consumer, not only
   the scheduler;
D. returning the last shared reservation wakes the OTHER waiting candidates.
*/

/** The only settling primitive allowed here: drain microtasks, never a timer. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-519-A",
    title: "Bootstrap card",
    description: "desc",
    column: "todo",
    status: null,
    paused: false,
    userPaused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  } as Task;
}

type Listener = (...args: any[]) => void;

function createEventedStore(overrides: Record<string, any> = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const store = {
    // 600 s: any observed pass in these tests came from an event, never from a tick.
    getSettings: vi.fn().mockResolvedValue({
      pollIntervalMs: 600_000,
      maxConcurrent: 4,
      maxWorktrees: 4,
      worktreeLimitEnabled: false,
      autoMerge: true,
      globalPause: false,
      enginePaused: false,
    }),
    listTasks: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, listener: Listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    }),
    ...overrides,
  } as any;
  return {
    store: store as TaskStore,
    emit(event: string, ...args: any[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
  };
}

beforeEach(() => {
  resetExecutorMocks();
  vi.clearAllMocks();
  vi.spyOn(planLog, "error").mockImplementation(() => undefined);
  vi.spyOn(planLog, "warn").mockImplementation(() => undefined);
  vi.spyOn(planLog, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  projectAdmissionCoordinator.clearReservationsForTests();
  clearPreHeldExecutorSlotsForTests();
  vi.restoreAllMocks();
});

describe("A — admissible card reaches planning discovery with no clock advance", () => {
  it("runs the planning pass on the move event itself", async () => {
    const { store, emit } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/fn-519");
    const poll = vi.spyOn(processor as any, "poll").mockResolvedValue(undefined);
    processor.start();
    await flushMicrotasks();
    poll.mockClear();

    emit("task:updated", createTask({ column: "todo" }), { lanes: { intake: "triage", hold: "todo" } });
    await flushMicrotasks();

    expect(poll).toHaveBeenCalledTimes(1);
    processor.stop();
  });

  it("coalesces a burst of moves into a single pass", async () => {
    const { store, emit } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/fn-519");
    const poll = vi.spyOn(processor as any, "poll").mockResolvedValue(undefined);
    processor.start();
    await flushMicrotasks();
    poll.mockClear();

    for (let i = 0; i < 5; i++) {
      emit("task:updated", createTask({ id: `FN-519-A${i}`, column: "todo" }));
    }
    await flushMicrotasks();

    expect(poll).toHaveBeenCalledTimes(1);
    processor.stop();
  });

  it("replays a wake that arrived while a pass was already reading, without a tick", async () => {
    const { store, emit } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/fn-519");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Armed only after the start()-triggered pass has settled, so the scenario under test is the
    // FIRST event-driven pass holding the re-entrance guard — not startup.
    let armGate = false;
    const poll = vi.spyOn(processor as any, "poll").mockImplementation(async () => {
      (processor as any).polling = true;
      if (armGate) {
        armGate = false;
        await gate;
      }
      (processor as any).polling = false;
      if ((processor as any).nudgeDuringPoll) {
        (processor as any).nudgeDuringPoll = false;
        processor.requestImmediatePoll();
      }
    });
    processor.start();
    await flushMicrotasks();
    poll.mockClear();
    armGate = true;

    emit("task:updated", createTask({ column: "todo" }));
    await flushMicrotasks();
    expect(poll).toHaveBeenCalledTimes(1);

    // Event lands mid-pass: it must not be swallowed by the re-entrance guard.
    emit("task:updated", createTask({ id: "FN-519-A2", column: "todo" }));
    release();
    await flushMicrotasks();

    expect(poll).toHaveBeenCalledTimes(2);
    processor.stop();
  });

  it("does not dispatch anything after stop(), even with a queued wake", async () => {
    const { store, emit } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/fn-519");
    const poll = vi.spyOn(processor as any, "poll").mockResolvedValue(undefined);
    processor.start();
    await flushMicrotasks();
    poll.mockClear();

    emit("task:updated", createTask({ column: "todo" }));
    processor.stop();
    await flushMicrotasks();

    expect(poll).not.toHaveBeenCalled();
  });

  it("routes an engine/global unpause through the lossless wake primitive", async () => {
    const { store, emit } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/fn-519");
    vi.spyOn(processor as any, "poll").mockResolvedValue(undefined);
    processor.start();
    await flushMicrotasks();
    const wake = vi.spyOn(processor, "requestImmediatePoll");

    emit("settings:updated", { settings: { globalPause: false }, previous: { globalPause: true } });
    emit("settings:updated", { settings: { enginePaused: false }, previous: { enginePaused: true } });
    await flushMicrotasks();

    // Both resume handlers must use the coalescing pump rather than calling a pass that the
    // re-entrance guard can silently drop.
    expect(wake).toHaveBeenCalledTimes(2);
    processor.stop();
  });
});

describe("A2 — an immediate wake must not become a busy loop", () => {
  /*
  FNXC:EventDrivenDispatch 2026-09-18-00:40:
  Removing the 150 ms window removes the accidental rate limit it also provided, so the
  no-progress case has to be asserted explicitly: a pass that admits nothing must not publish a
  new wake. Left unguarded this is a hot loop that burns a core while the board looks idle.
  */
  it("stops after one pass when discovery finds no candidate", async () => {
    const { store } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/fn-519");
    (processor as unknown as { running: boolean }).running = true;
    vi.spyOn(processor as any, "discoverReadyPlanningTasks").mockResolvedValue([]);
    vi.spyOn(processor as any, "sweepStalePlanningStatuses").mockResolvedValue(undefined);

    processor.requestImmediatePoll();
    await flushMicrotasks();
    await flushMicrotasks();

    // One event-driven pass, and no self-sustaining re-wake behind it.
    expect((processor as any).nudgePending).toBe(false);
    expect((processor as any).nudgeDuringPoll).toBe(false);
    processor.stop();
  });
});

describe("B — planner-live deferral is released when the planner is actually gone", () => {
  function deferredItem(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
    return {
      id: "wi-1",
      taskId: "FN-519-B",
      kind: "task",
      state: "runnable",
      waitReason: "planning",
      retryAfter: "2026-09-18T00:15:00.000Z",
      nodeId: "plan-review",
      attempt: 0,
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
      ...overrides,
    } as WorkflowWorkItem;
  }

  it("clears the deferral under compare-and-set and wakes the consumer", async () => {
    const transition = vi.fn(async () => undefined);
    const kick = vi.fn();
    const released = await wakePlannerLiveDeferredContinuations({
      taskId: "FN-519-B",
      list: async () => [deferredItem()],
      transition,
      kick,
      warn: () => undefined,
    });

    expect(released).toBe(1);
    expect(transition).toHaveBeenCalledWith("wi-1", "runnable", {
      expectedState: "runnable",
      retryAfter: null,
    });
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("never disturbs a running item, a non-planning wait, or an undeferred item", async () => {
    const transition = vi.fn(async () => undefined);
    const kick = vi.fn();
    const released = await wakePlannerLiveDeferredContinuations({
      taskId: "FN-519-B",
      list: async () => [
        deferredItem({ id: "running", state: "running" }),
        deferredItem({ id: "capacity", waitReason: "capacity" }),
        deferredItem({ id: "not-deferred", retryAfter: null }),
        deferredItem({ id: "terminal", state: "succeeded" }),
      ],
      transition,
      kick,
      warn: () => undefined,
    });

    expect(released).toBe(0);
    expect(transition).not.toHaveBeenCalled();
    // The consumer is still woken so the normal classifier stays authoritative.
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("wakes the consumer even when inspection or a CAS write fails", async () => {
    const kick = vi.fn();
    const warn = vi.fn();
    const released = await wakePlannerLiveDeferredContinuations({
      taskId: "FN-519-B",
      list: async () => { throw new Error("store down"); },
      transition: async () => undefined,
      kick,
      warn,
    });
    expect(released).toBe(0);
    expect(kick).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();

    const kick2 = vi.fn();
    const warn2 = vi.fn();
    const released2 = await wakePlannerLiveDeferredContinuations({
      taskId: "FN-519-B",
      list: async () => [deferredItem()],
      transition: async () => { throw new Error("CAS lost"); },
      kick: kick2,
      warn: warn2,
    });
    expect(released2).toBe(0);
    expect(kick2).toHaveBeenCalledTimes(1);
    expect(warn2).toHaveBeenCalled();
  });
});

describe("C — a released planning owner wakes the review consumer, not only the scheduler", () => {
  it("passes the finished task id to the release listener after ownership clears", async () => {
    const store = createEventedStore().store;
    const releases: Array<string | undefined> = [];
    const processor = new TriageProcessor(store, "/tmp/fn-519", {
      onPlanningSlotReleased: (taskId?: string) => {
        releases.push(taskId);
        // Proof the owner set is already clear when the listener runs: otherwise the review it
        // wakes would meet `planner-live` again and re-defer.
        expect(processor.getPlanningTaskIds().has("FN-519-C")).toBe(false);
      },
    });
    (processor as unknown as { running: boolean }).running = true;
    vi.spyOn(processor, "specifyTask").mockResolvedValue(undefined as any);
    vi.spyOn(processor, "requestImmediatePoll").mockReturnValue(true);

    (processor as any).startAdmittedPlanning(createTask({ id: "FN-519-C" }));
    await flushMicrotasks();

    expect(releases).toEqual(["FN-519-C"]);
    processor.stop();
  });

  it("still releases (with the id) when the planning promise rejects", async () => {
    const store = createEventedStore().store;
    const releases: Array<string | undefined> = [];
    const processor = new TriageProcessor(store, "/tmp/fn-519", {
      onPlanningSlotReleased: (taskId?: string) => releases.push(taskId),
    });
    (processor as unknown as { running: boolean }).running = true;
    vi.spyOn(processor, "specifyTask").mockRejectedValue(new Error("planner blew up"));
    vi.spyOn(processor as any, "parkPlanningRecoveryWriteFailure").mockResolvedValue(undefined);
    vi.spyOn(processor, "requestImmediatePoll").mockReturnValue(true);

    (processor as any).startAdmittedPlanning(createTask({ id: "FN-519-C2" }));
    await flushMicrotasks();

    expect(releases).toEqual(["FN-519-C2"]);
    processor.stop();
  });
});

describe("D — returning the last shared reservation wakes the other candidates", () => {
  it("notifies subscribers for the owning project only", async () => {
    const mine: string[] = [];
    const other: string[] = [];
    const offMine = projectAdmissionCoordinator.onReservationReleased("/p/a", (taskId) => mine.push(taskId));
    const offOther = projectAdmissionCoordinator.onReservationReleased("/p/b", (taskId) => other.push(taskId));

    await projectAdmissionCoordinator.admitNext({
      projectId: "/p/a",
      maxConcurrent: 1,
      claimed: () => 0,
      claimedTaskIds: () => [],
      refresh: async () => [{
        taskId: "FN-519-D1",
        projectId: "/p/a",
        lane: "execute",
        consumesWorktree: false,
        createdAt: "2026-09-18T00:00:00.000Z",
        start: async () => undefined,
      }],
    } as any);

    expect(mine).toEqual([]);
    projectAdmissionCoordinator.releaseReservation("FN-519-D1");

    expect(mine).toEqual(["FN-519-D1"]);
    expect(other).toEqual([]);

    // Duplicate release is a no-op, so a waiting lane cannot be woken twice for one slot.
    projectAdmissionCoordinator.releaseReservation("FN-519-D1");
    expect(mine).toEqual(["FN-519-D1"]);

    offMine();
    offOther();
  });

  it("isolates a throwing subscriber from the release and from its peers", async () => {
    const seen: string[] = [];
    const offBad = projectAdmissionCoordinator.onReservationReleased("/p/c", () => {
      throw new Error("listener exploded");
    });
    const offGood = projectAdmissionCoordinator.onReservationReleased("/p/c", (taskId) => seen.push(taskId));

    await projectAdmissionCoordinator.admitNext({
      projectId: "/p/c",
      maxConcurrent: 1,
      claimed: () => 0,
      claimedTaskIds: () => [],
      refresh: async () => [{
        taskId: "FN-519-D2",
        projectId: "/p/c",
        lane: "execute",
        consumesWorktree: false,
        createdAt: "2026-09-18T00:00:00.000Z",
        start: async () => undefined,
      }],
    } as any);

    expect(() => projectAdmissionCoordinator.releaseReservation("FN-519-D2")).not.toThrow();
    expect(seen).toEqual(["FN-519-D2"]);
    expect(projectAdmissionCoordinator.inspectProjectStateForTests("/p/c").reservedCount).toBe(0);

    offBad();
    offGood();
  });

  /*
  FNXC:EventDrivenDispatch 2026-09-18-00:40:
  The end-to-end shape of the reported symptom: capacity 1, two eligible cards, the first finishes,
  and the second must start WITHOUT a tick. The real coordinator and the real release helpers are
  used — a spy on a wake function would prove only that a function was called, not that a second
  card reached a claim.
  */
  it("admits the waiting card when the last slot is returned, with no clock advance", async () => {
    const started: string[] = [];
    const candidates = () => ["FN-CAP-A", "FN-CAP-B"]
      .filter((id) => !started.includes(id))
      .map((id) => ({
        taskId: id,
        projectId: "/p/cap",
        lane: "execute",
        consumesWorktree: false,
        createdAt: id === "FN-CAP-A" ? "2026-09-18T00:00:00.000Z" : "2026-09-18T00:00:01.000Z",
        reserve: () => registerPreHeldExecutorSlot(id, false),
        start: async () => { started.push(id); },
      }));

    const admit = async () => projectAdmissionCoordinator.admitNext({
      projectId: "/p/cap",
      maxConcurrent: 1,
      // Capacity 1: whatever has started and not yet released still occupies the slot.
      claimed: () => started.length - releasedCount,
      claimedTaskIds: () => started.filter((id) => !releasedIds.includes(id)),
      refresh: async () => candidates() as any,
    } as any);

    let releasedCount = 0;
    const releasedIds: string[] = [];
    // The wake consumer is the SAME admission pass the lane runs, bound through the production
    // release signal rather than called by the test.
    const off = projectAdmissionCoordinator.onReservationReleased("/p/cap", () => { void admit(); });

    await admit();
    expect(started).toEqual(["FN-CAP-A"]); // oldest-first order preserved

    // Finishing the first card returns its slot through the ordinary production helper.
    releasedCount += 1;
    releasedIds.push("FN-CAP-A");
    releasePreHeldAdmissionReservation("FN-CAP-A");
    await flushMicrotasks();

    expect(started).toEqual(["FN-CAP-A", "FN-CAP-B"]);
    off();
  });

  it("does not exceed capacity when a duplicate release wake arrives", async () => {
    const started: string[] = [];
    /** Cards currently occupying the single slot; a finished card leaves it. */
    const live = new Set<string>();
    const off = projectAdmissionCoordinator.onReservationReleased("/p/dup", () => {
      void projectAdmissionCoordinator.admitNext({
        projectId: "/p/dup",
        maxConcurrent: 1,
        claimed: () => live.size,
        claimedTaskIds: () => [...live],
        refresh: async () => started.includes("FN-DUP-B") ? [] : [{
          taskId: "FN-DUP-B",
          projectId: "/p/dup",
          lane: "execute",
          consumesWorktree: false,
          createdAt: "2026-09-18T00:00:01.000Z",
          start: async () => { started.push("FN-DUP-B"); live.add("FN-DUP-B"); },
        }] as any,
      } as any);
    });

    registerPreHeldExecutorSlot("FN-DUP-A", false);
    await projectAdmissionCoordinator.admitNext({
      projectId: "/p/dup",
      maxConcurrent: 1,
      claimed: () => live.size,
      claimedTaskIds: () => [...live],
      refresh: async () => [{
        taskId: "FN-DUP-A",
        projectId: "/p/dup",
        lane: "execute",
        consumesWorktree: false,
        createdAt: "2026-09-18T00:00:00.000Z",
        start: async () => { started.push("FN-DUP-A"); live.add("FN-DUP-A"); },
      }] as any,
    } as any);
    expect(started).toEqual(["FN-DUP-A"]);

    // A finishes, then returns its reservation TWICE. The second call finds nothing to delete, so
    // it publishes nothing and cannot produce a second claim over the cap.
    live.delete("FN-DUP-A");
    releasePreHeldAdmissionReservation("FN-DUP-A");
    projectAdmissionCoordinator.releaseReservation("FN-DUP-A");
    await flushMicrotasks();
    await flushMicrotasks();

    expect(started).toEqual(["FN-DUP-A", "FN-DUP-B"]);
    expect(started.filter((id) => id === "FN-DUP-B")).toHaveLength(1);
    off();
  });

  it("does not admit when the wake arrives before the slot is actually returned", async () => {
    const started: string[] = [];
    registerPreHeldExecutorSlot("FN-EARLY-A", false);
    await projectAdmissionCoordinator.admitNext({
      projectId: "/p/early",
      maxConcurrent: 1,
      claimed: () => started.length,
      claimedTaskIds: () => started,
      refresh: async () => [{
        taskId: "FN-EARLY-A",
        projectId: "/p/early",
        lane: "execute",
        consumesWorktree: false,
        createdAt: "2026-09-18T00:00:00.000Z",
        start: async () => { started.push("FN-EARLY-A"); },
      }] as any,
    } as any);

    // An early wake (published before the owner's cleanup) must be refused by the capacity read,
    // which is why the reservation-change signal cannot replace the owner-cleanup signal.
    await projectAdmissionCoordinator.admitNext({
      projectId: "/p/early",
      maxConcurrent: 1,
      claimed: () => started.length,
      claimedTaskIds: () => started,
      refresh: async () => [{
        taskId: "FN-EARLY-B",
        projectId: "/p/early",
        lane: "execute",
        consumesWorktree: false,
        createdAt: "2026-09-18T00:00:01.000Z",
        start: async () => { started.push("FN-EARLY-B"); },
      }] as any,
    } as any);

    expect(started).toEqual(["FN-EARLY-A"]);
    releasePreHeldAdmissionReservation("FN-EARLY-A");
  });

  it("stops notifying after the subscriber is disposed", async () => {
    const seen: string[] = [];
    const off = projectAdmissionCoordinator.onReservationReleased("/p/d", (taskId) => seen.push(taskId));
    off();

    await projectAdmissionCoordinator.admitNext({
      projectId: "/p/d",
      maxConcurrent: 1,
      claimed: () => 0,
      claimedTaskIds: () => [],
      refresh: async () => [{
        taskId: "FN-519-D3",
        projectId: "/p/d",
        lane: "execute",
        consumesWorktree: false,
        createdAt: "2026-09-18T00:00:00.000Z",
        start: async () => undefined,
      }],
    } as any);
    projectAdmissionCoordinator.releaseReservation("FN-519-D3");

    expect(seen).toEqual([]);
  });
});
