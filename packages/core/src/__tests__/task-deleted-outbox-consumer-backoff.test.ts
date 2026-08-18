/*
FNXC:TaskLifecycleConsumerIdleBackoff 2026-08-13-06:41 (RUFU-074):
In-memory regression test (no real DB, fake timers, vi.mock fakes per docs/testing.md) proving that
a TaskDeletedOutboxConsumer with an idle outbox backs off its poll interval toward the 60s cap
instead of polling a fixed 5s forever, while burst events arriving mid-backoff are still delivered
with fenced, in-order cursor advance that resets the cadence to the fast 5s base. The invariant:
idle/active/waiting feedback from each poll drives the rescheduling delay; fencing/ordering/
at-least-once delivery logic is untouched (backoff only changes when poll() runs). Review fix
2026-08-18-00:55: retry and error outcomes are "waiting", not "idle" — they must not extend the
backoff toward the cap, so transient failures recover on the fast 5s cadence.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TASK_DELETED_OUTBOX_BACKOFF_STEP_MS,
  TASK_DELETED_OUTBOX_MAX_POLL_MS,
  TASK_DELETED_OUTBOX_POLL_MS,
  TASK_DELETED_OUTBOX_POLL_JITTER_RATIO,
  TaskDeletedOutboxConsumer,
  applyPollJitter,
} from "../task-store/task-deleted-outbox-consumer.js";
import { buildConsumerId } from "../task-store/task-lifecycle-consumer-identity.js";
import type { TaskStore } from "../store.js";

const mocks = vi.hoisted(() => ({
  registerTaskLifecycleConsumer: vi.fn(),
  setTaskLifecycleConsumerActive: vi.fn(),
  acquireTaskLifecycleLease: vi.fn(),
  readTaskLifecycleConsumerCursor: vi.fn(),
  readTaskLifecycleEventBounds: vi.fn(),
  listTaskLifecycleEvents: vi.fn(),
  hasTaskLifecycleConsumerReceipt: vi.fn(),
  acknowledgeTaskLifecycleEvent: vi.fn(),
  advanceTaskLifecycleConsumerCursor: vi.fn(),
  renewTaskLifecycleLease: vi.fn(),
  setTaskLifecycleConsumerRetry: vi.fn(),
  parkTaskLifecycleConsumerDeadLetter: vi.fn(),
  releaseTaskLifecycleLease: vi.fn(),
}));

vi.mock("../postgres/data-layer.js", () => ({
  recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../task-store/task-lifecycle-consumer-registry.js", () => ({
  acknowledgeTaskLifecycleEvent: mocks.acknowledgeTaskLifecycleEvent,
  acquireTaskLifecycleLease: mocks.acquireTaskLifecycleLease,
  advanceTaskLifecycleConsumerCursor: mocks.advanceTaskLifecycleConsumerCursor,
  hasTaskLifecycleConsumerReceipt: mocks.hasTaskLifecycleConsumerReceipt,
  listTaskLifecycleEvents: mocks.listTaskLifecycleEvents,
  registerTaskLifecycleConsumer: mocks.registerTaskLifecycleConsumer,
  releaseTaskLifecycleLease: mocks.releaseTaskLifecycleLease,
  readTaskLifecycleConsumerCursor: mocks.readTaskLifecycleConsumerCursor,
  readTaskLifecycleEventBounds: mocks.readTaskLifecycleEventBounds,
  renewTaskLifecycleLease: mocks.renewTaskLifecycleLease,
  setTaskLifecycleConsumerActive: mocks.setTaskLifecycleConsumerActive,
  setTaskLifecycleConsumerRetry: mocks.setTaskLifecycleConsumerRetry,
  parkTaskLifecycleConsumerDeadLetter: mocks.parkTaskLifecycleConsumerDeadLetter,
}));

type LifecycleEvent = {
  eventId: string;
  seq: bigint;
  eventType: string;
  taskId: string;
  occurredAt: string;
  createdAt: string;
  payload: Record<string, unknown>;
};

function makeCursor(lastAckedSeq = 0n) {
  return {
    lastAckedSeq,
    retryAttempts: 0,
    retryBackoffUntil: null,
    leaseToken: "lease",
    fencingToken: 41n,
    leaseExpiresAt: "2026-01-01T00:00:60.000Z",
    // Recent ack timestamp so needsReconciliation does not trigger the 30-day fallback (which
    // requires a real layer.db the fake does not provide).
    updatedAt: new Date().toISOString(),
  };
}

function taskDeletedEvent(seq: bigint, taskId: string, eventId?: string): LifecycleEvent {
  return {
    eventId: eventId ?? `evt-${seq}`,
    seq,
    eventType: "task:deleted",
    taskId,
    occurredAt: "2026-01-02T00:00:00.000Z",
    createdAt: "2026-01-02T00:00:00.000Z",
    payload: {
      taskId,
      previousColumn: "done",
      previousStatus: null,
      deletedAt: "2026-01-02T00:00:00.000Z",
      allowResurrection: false,
      githubIssueAction: null,
      closureContext: null,
      deletedBy: null,
    },
  };
}

/** Fake TaskStore carrying asyncLayer + consumerId + taskCache for the consumer's seam. */
function makeStore(consumerId: string, taskCache: Map<string, unknown> = new Map()) {
  return {
    asyncLayer: { projectId: `project-${consumerId}` },
    consumerId,
    taskCache,
    emitObservedTaskDeleted: vi.fn(),
  } as unknown as TaskStore;
}

/** Records the fake-clock time of every outbox read (one per completed poll). */
function scriptDefaults(events: () => LifecycleEvent[]) {
  const pollTimes: number[] = [];
  mocks.acquireTaskLifecycleLease.mockImplementation(async () => ({
    token: "lease-token",
    fencingToken: 41n,
    expiresAt: "2026-01-01T00:00:60.000Z",
  }));
  mocks.readTaskLifecycleConsumerCursor.mockImplementation(async () => makeCursor());
  mocks.readTaskLifecycleEventBounds.mockImplementation(async () => ({
    oldestSeq: null,
    oldestOccurredAt: null,
    headSeq: 0n,
  }));
  mocks.listTaskLifecycleEvents.mockImplementation(async () => {
    pollTimes.push(Date.now());
    return events();
  });
  mocks.hasTaskLifecycleConsumerReceipt.mockImplementation(async () => false);
  mocks.acknowledgeTaskLifecycleEvent.mockImplementation(async () => true);
  mocks.renewTaskLifecycleLease.mockImplementation(async () => true);
  mocks.registerTaskLifecycleConsumer.mockImplementation(async () => undefined);
  mocks.setTaskLifecycleConsumerActive.mockImplementation(async () => undefined);
  mocks.releaseTaskLifecycleLease.mockImplementation(async () => undefined);
  return { pollTimes };
}

function collect(times: number[]): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  return gaps;
}

beforeEach(() => {
  vi.useFakeTimers();
  // Fail fast if an unmocked registry call leaks through to DB code.
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskDeletedOutboxConsumer idle backoff", () => {
  it("backs an idle dashboard consumer way below the fixed-5s poll rate and reaches the 60s cap", async () => {
    const { pollTimes } = scriptDefaults(() => []);
    const store = makeStore(buildConsumerId("dashboard"));
    const consumer = new TaskDeletedOutboxConsumer(store);
    await consumer.start();
    const startPolls = pollTimes.length;

    // Fixed-5s poller would fire ~12 times in 60s; a backed-off idle consumer must not.
    await vi.advanceTimersByTimeAsync(60_000);
    const reads = pollTimes.length - startPolls;
    expect(reads).toBeLessThan(6);

    // Let the cadence plateau so the deterministic delay provably hits the cap.
    await vi.advanceTimersByTimeAsync(300_000);
    const computeNextDelay = (consumer as unknown as { computeNextPollDelayMs(): number }).computeNextPollDelayMs;
    expect(computeNextDelay.call(consumer)).toBe(TASK_DELETED_OUTBOX_MAX_POLL_MS);

    // De-synchronization jitter keeps the capped delay bounded and never below the fast base.
    for (let i = 0; i < 200; i++) {
      const jittered = applyPollJitter(TASK_DELETED_OUTBOX_MAX_POLL_MS);
      expect(jittered).toBeGreaterThanOrEqual(TASK_DELETED_OUTBOX_POLL_MS);
      expect(jittered).toBeLessThanOrEqual(TASK_DELETED_OUTBOX_MAX_POLL_MS * (1 + TASK_DELETED_OUTBOX_POLL_JITTER_RATIO));
    }

    await consumer.stop();
  });

  it("keeps an active engine consumer on the fast 5s cadence while it delivers events", async () => {
    const consumerId = buildConsumerId("engine");
    const store = makeStore(
      consumerId,
      new Map([["FN-STAY", { id: "FN-STAY", title: "stay" }]]),
    );
    const { pollTimes } = scriptDefaults(() => [taskDeletedEvent(10n, "FN-STAY")]);
    const consumer = new TaskDeletedOutboxConsumer(store);
    await consumer.start();

    await vi.advanceTimersByTimeAsync(60_000);
    const gaps = collect(pollTimes);
    // Active cadence stays at the jittered 5s base (4000-6000ms), with no spurious backoff.
    expect(gaps).not.toHaveLength(0);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(TASK_DELETED_OUTBOX_POLL_MS * (1 - TASK_DELETED_OUTBOX_POLL_JITTER_RATIO));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(TASK_DELETED_OUTBOX_POLL_MS * (1 + TASK_DELETED_OUTBOX_POLL_JITTER_RATIO));
    // Events were actually delivered through the fenced ack seam.
    expect(store.emitObservedTaskDeleted).toHaveBeenCalled();
    expect(mocks.acknowledgeTaskLifecycleEvent).toHaveBeenCalled();

    await consumer.stop();
  });

  it("backs off an idle engine consumer independently from a concurrent active dashboard consumer", async () => {
    // Both consumers share the module-level listTaskLifecycleEvents mock, so the reader dispatches
    // on the per-store layer.projectId (the only cross-consumer discriminator the registry receives)
    // rather than arming two competing global mockImplementations.
    const idleTimes: number[] = [];
    const activeTimes: number[] = [];
    scriptDefaults(() => []);
    const idleStore = makeStore(buildConsumerId("engine"), new Map([["FN-ACTIVE", { id: "FN-ACTIVE", title: "a" }]]));
    const activeStore = makeStore(buildConsumerId("dashboard"), new Map([["FN-ACTIVE", { id: "FN-ACTIVE", title: "a" }]]));

    let seq = 100n;
    mocks.listTaskLifecycleEvents.mockImplementation(async (layer: { projectId: string }) => {
      if (layer.projectId === idleStore.asyncLayer!.projectId) {
        idleTimes.push(Date.now());
        return []; // idle engine consumer -> empty outbox every poll
      }
      activeTimes.push(Date.now());
      seq += 1n;
      return [taskDeletedEvent(seq, "FN-ACTIVE")]; // active dashboard consumer -> fresh event
    });

    const idleConsumer = new TaskDeletedOutboxConsumer(idleStore);
    await idleConsumer.start();
    // Give the idle consumer a head start so backoff is already engaged.
    await vi.advanceTimersByTimeAsync(80_000);

    const activeConsumer = new TaskDeletedOutboxConsumer(activeStore);
    await activeConsumer.start();
    await vi.advanceTimersByTimeAsync(60_000);
    const idleGaps = collect(idleTimes);
    const activeGaps = collect(activeTimes);
    // No cross-talk: the idle engine consumer backs off well beyond a 5s cadence...
    expect(idleGaps).toContainEqual(expect.any(Number));
    expect(Math.max(...idleGaps)).toBeGreaterThanOrEqual(TASK_DELETED_OUTBOX_POLL_MS * 2);
    // ...while the active dashboard consumer keeps polling at the fast base.
    expect(activeGaps).not.toHaveLength(0);
    expect(Math.max(...activeGaps)).toBeLessThanOrEqual(TASK_DELETED_OUTBOX_POLL_MS * (1 + TASK_DELETED_OUTBOX_POLL_JITTER_RATIO));

    await activeConsumer.stop();
    await idleConsumer.stop();
  });

  it("delivers a burst arriving mid-backoff in order with fenced acks and resets to the fast cadence", async () => {
    const burst = [
      taskDeletedEvent(1n, "FN-A"),
      taskDeletedEvent(2n, "FN-B"),
      taskDeletedEvent(3n, "FN-C"),
    ];
    const store = makeStore(
      buildConsumerId("dashboard"),
      new Map([
        ["FN-A", { id: "FN-A", title: "a" }],
        ["FN-B", { id: "FN-B", title: "b" }],
        ["FN-C", { id: "FN-C", title: "c" }],
      ]),
    );
    // Start idle, then arm a one-time burst once the consumer has backed off. The stateful reader
    // returns the full burst exactly once (one poll) and then the empty outbox, so the burst is
    // consumed by a single mid-backoff poll rather than re-delivered every poll in the window.
    let burstLeft = 0;
    const readEvents = (): LifecycleEvent[] => {
      if (burstLeft > 0) {
        burstLeft -= 1;
        return burst;
      }
      return [];
    };
    const { pollTimes } = scriptDefaults(() => readEvents());
    const consumer = new TaskDeletedOutboxConsumer(store);
    await consumer.start();
    await vi.advanceTimersByTimeAsync(60_000); // engaged deeper backoff
    const beforeBurstPolls = pollTimes.length;

    const preBurstAcks = mocks.acknowledgeTaskLifecycleEvent.mock.calls.length;
    burstLeft = 1; // burst arrives mid-backoff; next delayed poll consumes all of it
    await vi.advanceTimersByTimeAsync(120_000);

    // The burst poll delivered all N events in order.
    const deliveredIds = store.emitObservedTaskDeleted.mock.calls.map((c) => c[0].id);
    expect(deliveredIds).toEqual(["FN-A", "FN-B", "FN-C"]);
    const burstAcks = mocks.acknowledgeTaskLifecycleEvent.mock.calls.slice(preBurstAcks);
    expect(burstAcks).toHaveLength(3);
    // acknowledgeTaskLifecycleEvent(layer, { consumerId, eventId, seq, priorSeq, fencingToken }): the
    // fenced-ack payload is the second argument, so the ack assertions read call[1].
    const ackedSeqs = burstAcks.map((c) => c[1].seq);
    expect(ackedSeqs).toEqual([1n, 2n, 3n]); // cursor advanced in order
    for (const call of burstAcks) {
      expect(call[1].fencingToken).toBe(41n); // every fenced ack honors the acquired lease token
    }

    // The burst poll was observed (outbox read happened), proving mid-backoff delivery.
    const deliveredSince = store.emitObservedTaskDeleted.mock.calls.length;
    expect(deliveredSince).toBe(3);
    expect(pollTimes.length).toBeGreaterThan(beforeBurstPolls);

    // Cadence resets to the fast base after the burst (idlePollsSinceEvent cleared).
    const burstAt = pollTimes[beforeBurstPolls];
    const nextRead = pollTimes[beforeBurstPolls + 1];
    const resetGap = nextRead - burstAt;
    expect(resetGap).toBeGreaterThanOrEqual(TASK_DELETED_OUTBOX_POLL_MS * (1 - TASK_DELETED_OUTBOX_POLL_JITTER_RATIO));
    expect(resetGap).toBeLessThanOrEqual(TASK_DELETED_OUTBOX_POLL_MS * (1 + TASK_DELETED_OUTBOX_POLL_JITTER_RATIO));

    await consumer.stop();
  });

  it("disarms the rescheduled timer on stop so shutdown cannot leave an orphaned poll", async () => {
    const { pollTimes } = scriptDefaults(() => []);
    const store = makeStore(buildConsumerId("dashboard"));
    const consumer = new TaskDeletedOutboxConsumer(store);
    await consumer.start();

    await consumer.stop();
    const before = pollTimes.length;
    await vi.advanceTimersByTimeAsync(10 * TASK_DELETED_OUTBOX_MAX_POLL_MS);
    // No further polls fire after stop(); a manual poll() reports "waiting" (not running) and does
    // not read the outbox.
    expect(pollTimes.length).toBe(before);
    const result = await consumer.poll();
    expect(result).toBe("waiting");
    expect(pollTimes.length).toBe(before);

    // A second stop() must also be safe (no throw, no timer double-clear crash).
    await expect(consumer.stop()).resolves.toBeUndefined();
  });

  it("keeps the backoff step constant growing toward the cap and never below base", () => {
    // The deterministic growth curve: 5s -> 15s -> 25s -> ... -> 60s.
    expect(TASK_DELETED_OUTBOX_BACKOFF_STEP_MS).toBe(10_000);
    const consumer = new TaskDeletedOutboxConsumer(makeStore(buildConsumerId("engine")));
    const computeNextDelay = (consumer as unknown as { computeNextPollDelayMs(): number }).computeNextPollDelayMs;
    // Drives the private idle counter through repeated simulated idle polls via the private seam.
    const state = consumer as unknown as { idlePollsSinceEvent: number };
    for (let idle = 1; idle <= 10; idle++) {
      state.idlePollsSinceEvent = idle;
      expect(computeNextDelay.call(consumer)).toBe(
        Math.min(TASK_DELETED_OUTBOX_POLL_MS + idle * TASK_DELETED_OUTBOX_BACKOFF_STEP_MS, TASK_DELETED_OUTBOX_MAX_POLL_MS),
      );
    }
    expect(computeNextDelay.call(consumer)).toBe(TASK_DELETED_OUTBOX_MAX_POLL_MS);
  });

  it("does not classify poll errors as idle: the error streak stays on the fast 5s base and recovers quickly", async () => {
    const store = makeStore(buildConsumerId("engine"), new Map([[
      "FN-ERR", { id: "FN-ERR", title: "err" },
    ]]));
    const { pollTimes } = scriptDefaults(() => [taskDeletedEvent(5n, "FN-ERR")]);
    const consumer = new TaskDeletedOutboxConsumer(store);
    await consumer.start();

    // Simulate a transient DB failure on the next polls (the outbox reader records the poll time,
    // then throws; pollSafely maps the error to "waiting").
    mocks.listTaskLifecycleEvents.mockImplementation(async () => {
      pollTimes.push(Date.now());
      throw new Error("pg transient failure");
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const errorGaps = collect(pollTimes);
    // Error polls are "waiting", never "idle": the cadence must stay at the jittered 5s base
    // (4000-6000ms) — an idle streak of the same length would have grown it to 35s+.
    expect(errorGaps.length).toBeGreaterThan(0);
    expect(Math.max(...errorGaps)).toBeLessThanOrEqual(TASK_DELETED_OUTBOX_POLL_MS * (1 + TASK_DELETED_OUTBOX_POLL_JITTER_RATIO));

    // The failure clears: the very next poll (still on the 5s base, not hidden behind a grown
    // cap) delivers the pending event. (At-least-once: the mock receipt stays false, so the event
    // is redelivered.)
    mocks.listTaskLifecycleEvents.mockImplementation(async () => { pollTimes.push(Date.now()); return [taskDeletedEvent(5n, "FN-ERR")]; });
    const beforeRecovery = pollTimes.length;
    const callsBeforeRecovery = store.emitObservedTaskDeleted.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TASK_DELETED_OUTBOX_POLL_MS * 2 * (1 + TASK_DELETED_OUTBOX_POLL_JITTER_RATIO));
    expect(pollTimes.length).toBeGreaterThan(beforeRecovery);
    expect(store.emitObservedTaskDeleted.mock.calls.length).toBeGreaterThan(callsBeforeRecovery);

    await consumer.stop();
  });

  it("does not classify the per-event retry-backoff window as idle", async () => {
    const store = makeStore(buildConsumerId("engine"));
    scriptDefaults(() => []);
    // The cursor is inside its per-event retry window: the poll must take the "waiting" early
    // return BEFORE reading the outbox. Record the cursor reads (one per waiting poll) instead of
    // outbox reads, which the early return never reaches.
    const cursorReads: number[] = [];
    mocks.readTaskLifecycleConsumerCursor.mockImplementation(async () => {
      cursorReads.push(Date.now());
      return { ...makeCursor(), retryBackoffUntil: new Date(Date.now() + 300_000).toISOString() };
    });
    const consumer = new TaskDeletedOutboxConsumer(store);
    await consumer.start();

    await vi.advanceTimersByTimeAsync(20_000);
    const gaps = collect(cursorReads);
    // Waiting polls stay on the fast 5s base — the retry window is a scheduled wait, not an idle
    // streak growing the delay toward the 60s cap.
    expect(gaps.length).toBeGreaterThan(0);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(TASK_DELETED_OUTBOX_POLL_MS * (1 + TASK_DELETED_OUTBOX_POLL_JITTER_RATIO));
    // The outbox was never read during the window (the early return precedes it).
    expect(mocks.listTaskLifecycleEvents).not.toHaveBeenCalled();

    await consumer.stop();
  });
});