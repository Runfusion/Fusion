import { describe, expect, it, vi } from "vitest";

import {
  createDispatchLatencyRecorder,
  dispatchLatencySignature,
} from "../util/dispatch-latency.js";
import type { DispatchLatencyObservation } from "../util/dispatch-latency.js";

/*
FNXC:EventDrivenDispatch 2026-09-18-00:40:
FN-519 — hostile-sink coverage for the dispatch-latency diagnostic, at the OWNING CALL SITE rather
than only inside the bounded helper.

The rule this suite enforces is the project's standing one for new audit emitters: a sink may be
absent, throw, reject, hang, or settle LATE, and in every one of those cases the observable outcome
of the lane must be unchanged and no unhandled rejection may escape. That matters more here than
for most emitters, because this diagnostic exists to measure dispatch latency — if a stalled
telemetry sink could delay a claim, the measurement would have become the problem.

Also pinned: the payload boundary (ids, bounded enums, one duration) and the dedupe contract (a
stable refusal collapses; a CHANGED refusal reason is always reported; a claim is never swallowed).
*/

function observation(overrides: Partial<DispatchLatencyObservation> = {}): DispatchLatencyObservation {
  return {
    taskId: "FN-519-D",
    wakeOrigin: "local-publication",
    phase: "admission",
    outcome: "refused",
    reasonCode: "capacity",
    observedMs: 12,
    ...overrides,
  };
}

function capturingHost() {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    host: { recordRunAuditEvent: (input: unknown) => { events.push(input as Record<string, unknown>); } },
  };
}

describe("dispatch-latency diagnostic — hostile sinks", () => {
  it("records with a missing sink without throwing", () => {
    const recorder = createDispatchLatencyRecorder({ host: undefined });
    expect(recorder.record(observation())).toBe(true);
    expect(recorder.record(observation({ outcome: "claimed", reasonCode: undefined }))).toBe(true);
  });

  it("records with a sink that has no recordRunAuditEvent method", () => {
    const recorder = createDispatchLatencyRecorder({ host: {} as never });
    expect(recorder.record(observation())).toBe(true);
  });

  it("keeps the same observable result when the sink throws synchronously", () => {
    const recorder = createDispatchLatencyRecorder({
      host: { recordRunAuditEvent: () => { throw new Error("sink exploded"); } },
    });
    expect(recorder.record(observation())).toBe(true);
    // And a later distinct fact is still reported, so one bad write is not sticky.
    expect(recorder.record(observation({ reasonCode: "dependency" }))).toBe(true);
  });

  it("produces no unhandled rejection when the sink rejects", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const recorder = createDispatchLatencyRecorder({
        host: { recordRunAuditEvent: () => Promise.reject(new Error("sink rejected")) },
      });
      expect(recorder.record(observation())).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("returns immediately when the sink hangs, so a claim is never delayed", () => {
    // A never-settling sink. `record` must be SYNCHRONOUS from the lane's point of view: the whole
    // point of the diagnostic is that measuring the wait cannot create one.
    const recorder = createDispatchLatencyRecorder({
      host: { recordRunAuditEvent: () => new Promise(() => undefined) },
    });
    const before = Date.now();
    expect(recorder.record(observation())).toBe(true);
    expect(Date.now() - before).toBeLessThan(200);
  });

  it("absorbs a sink that settles long after the observation was recorded", async () => {
    let settle!: () => void;
    const recorder = createDispatchLatencyRecorder({
      host: { recordRunAuditEvent: () => new Promise<void>((resolve) => { settle = resolve; }) },
    });
    expect(recorder.record(observation())).toBe(true);
    // The lane has already moved on; a late settlement must be a no-op with no thrown error.
    settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recorder.retainedCount).toBe(1);
  });
});

describe("dispatch-latency diagnostic — payload boundary", () => {
  it("carries only ids, bounded enums, and one rounded duration", () => {
    const { events, host } = capturingHost();
    const recorder = createDispatchLatencyRecorder({ host: host as never });
    recorder.record(observation({ nodeId: "plan-review", observedMs: 1234.7 }));

    const metadata = events[0]?.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      "nodeId",
      "observedMs",
      "outcome",
      "phase",
      "reasonCode",
      "taskId",
      "wakeOrigin",
    ]);
    expect(metadata.observedMs).toBe(1235);
    // No content-bearing key of any kind: the transport and the audit row are both readable by
    // parties who must never see task content.
    const serialized = JSON.stringify(metadata);
    for (const forbidden of ["prompt", "title", "description", "password", "postgres://", "http"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("names a real limit with its fixed reason code rather than prose", () => {
    const { events, host } = capturingHost();
    const recorder = createDispatchLatencyRecorder({ host: host as never });
    recorder.record(observation({ reasonCode: "capacity" }));
    recorder.record(observation({ reasonCode: "awaiting-approval" }));
    recorder.record(observation({ reasonCode: "transport-degraded", wakeOrigin: "periodic-backstop" }));

    expect(events.map((e) => (e.metadata as Record<string, unknown>).reasonCode)).toEqual([
      "capacity",
      "awaiting-approval",
      "transport-degraded",
    ]);
    // A degraded transport is NAMED, and the backstop origin says the event path did not deliver.
    expect((events[2]!.metadata as Record<string, unknown>).wakeOrigin).toBe("periodic-backstop");
  });

  it("omits an absent duration instead of reporting a fabricated zero", () => {
    const { events, host } = capturingHost();
    const recorder = createDispatchLatencyRecorder({ host: host as never });
    recorder.record(observation({ observedMs: undefined }));

    expect((events[0]!.metadata as Record<string, unknown>).observedMs).toBeUndefined();
  });
});

describe("dispatch-latency diagnostic — dedupe contract", () => {
  it("collapses a stable refusal but always reports a changed reason", () => {
    const { events, host } = capturingHost();
    const recorder = createDispatchLatencyRecorder({ host: host as never });

    for (let i = 0; i < 20; i++) recorder.record(observation({ observedMs: i * 100 }));
    expect(events).toHaveLength(1);

    // A new fact about the same card is never swallowed.
    recorder.record(observation({ reasonCode: "dependency" }));
    expect(events).toHaveLength(2);
  });

  it("never suppresses a claim, and a claim clears the card's suppression", () => {
    const { events, host } = capturingHost();
    const recorder = createDispatchLatencyRecorder({ host: host as never });

    const claimed = observation({ outcome: "claimed", phase: "claim", reasonCode: undefined });
    recorder.record(claimed);
    recorder.record(claimed);
    // A claim is the answer to "when did it actually start?" — reported every time.
    expect(events).toHaveLength(2);

    recorder.record(observation());
    expect(events).toHaveLength(3);
    recorder.forget("FN-519-D");
    recorder.record(observation());
    expect(events).toHaveLength(4);
  });

  it("bounds retained signatures so a long-lived runtime cannot grow without limit", () => {
    const recorder = createDispatchLatencyRecorder({ host: undefined, maxSignatures: 3 });
    for (let i = 0; i < 50; i++) recorder.record(observation({ taskId: `FN-${i}` }));
    expect(recorder.retainedCount).toBeLessThanOrEqual(3);
  });

  it("keys the signature on facts, not on the measured duration", () => {
    expect(dispatchLatencySignature(observation({ observedMs: 1 })))
      .toBe(dispatchLatencySignature(observation({ observedMs: 99_999 })));
    expect(dispatchLatencySignature(observation({ reasonCode: "capacity" })))
      .not.toBe(dispatchLatencySignature(observation({ reasonCode: "paused" })));
    expect(dispatchLatencySignature(observation({ taskId: "FN-1" })))
      .not.toBe(dispatchLatencySignature(observation({ taskId: "FN-2" })));
  });
});
