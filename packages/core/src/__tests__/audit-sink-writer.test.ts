/**
 * RUFU-453 — the bounded drain writer is a pure function of its injected write, so every bound is
 * provable with a fake sink and no database: coalescing, the write bound, one-retry-then-spill,
 * overflow accounting, shutdown drain, and hostile-write containment.
 *
 * Bounds come from the writer's own env overrides so the case runs in single-digit milliseconds
 * instead of waiting on the production 25 ms window / 2000 ms bound (no-slow-tests rule).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RUN_AUDIT_SINK_BATCH_MAX,
  createRunAuditSinkWriter,
  type RunAuditSinkDeadLetter,
  type RunAuditSinkRow,
} from "../run-audit/audit-sink-writer.js";

function row(mutationType = "task:updated", target = "FN-1") {
  return {
    agentId: "executor",
    runId: "run-1",
    domain: "database" as const,
    mutationType,
    target,
    metadata: { taskId: "FN-1" },
  };
}

function fakeDeadLetter() {
  const appended: { row: RunAuditSinkRow; reason: string }[] = [];
  const sink: RunAuditSinkDeadLetter = {
    async append(rowArg, reason) {
      appended.push({ row: rowArg, reason });
      return { written: true, suppressed: false };
    },
    stats: () => ({ path: "/tmp/dead-letter.jsonl", bytes: 0, rows: appended.length }),
  };
  return { sink, appended };
}

/** A write the test controls: settles on command, reports every invocation and its concurrency. */
function controllableWrite(opts: { latencyMs?: number; fail?: boolean | (() => boolean); hang?: boolean } = {}) {
  const calls: RunAuditSinkRow[][] = [];
  let inFlight = 0;
  let peakConcurrency = 0;
  const write = async (rows: RunAuditSinkRow[]) => {
    calls.push(rows);
    inFlight += 1;
    peakConcurrency = Math.max(peakConcurrency, inFlight);
    try {
      // A hang with no timer at all: nothing here can then keep the vitest worker alive past the case.
      if (opts.hang) await new Promise<never>(() => {});
      if (opts.latencyMs) await new Promise((resolve) => setTimeout(resolve, opts.latencyMs));
      const shouldFail = typeof opts.fail === "function" ? opts.fail() : opts.fail === true;
      if (shouldFail) throw new Error("sink refused the batch");
    } finally {
      inFlight -= 1;
    }
  };
  return { write, calls, peak: () => peakConcurrency };
}

const FAST_ENV = {
  FUSION_RUN_AUDIT_SINK_FLUSH_WINDOW_MS: "1",
  FUSION_RUN_AUDIT_SINK_WRITE_BOUND_MS: "20",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createRunAuditSinkWriter", () => {
  it("coalesces 100 submits into ceil(100 / BATCH_MAX) writes instead of 100 transactions", async () => {
    const { write, calls, peak } = controllableWrite();
    const sink = createRunAuditSinkWriter({ write, env: { ...FAST_ENV, FUSION_RUN_AUDIT_SINK_FLUSH_WINDOW_MS: "50" } });

    for (let index = 0; index < 100; index += 1) sink.submit(row(`task:coalesced-${index}`));
    await sink.flush({ timeoutMs: 500 });

    expect(calls).toHaveLength(Math.ceil(100 / RUN_AUDIT_SINK_BATCH_MAX));
    expect(calls.every((batch) => batch.length <= RUN_AUDIT_SINK_BATCH_MAX)).toBe(true);
    expect(sink.stats().written).toBe(100);
    // A queue that never holds the window's rows is a queue with no backpressure signal.
    expect(sink.stats().coalesced).toBeGreaterThan(0);
    expect(sink.stats().queueDepth).toBe(0);
    expect(peak()).toBe(1);
  });

  it("runs one drain at a time even when submits keep arriving", async () => {
    const { write, calls, peak } = controllableWrite({ latencyMs: 5 });
    const sink = createRunAuditSinkWriter({ write, env: FAST_ENV });

    for (let index = 0; index < 17; index += 1) {
      sink.submit(row(`task:streaming-${index}`));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await sink.flush({ timeoutMs: 500 });

    expect(calls.length).toBeGreaterThan(1);
    expect(peak()).toBe(1);
    expect(sink.stats().written).toBe(17);
  });

  it("counts a wedged write as timedOut and then as lateRecorded when it finally lands", async () => {
    const { write, calls } = controllableWrite({ latencyMs: 60 });
    const sink = createRunAuditSinkWriter({ write, env: FAST_ENV });

    sink.submit(row("task:wedged-a"));
    sink.submit(row("task:wedged-b"));
    await sink.flush({ timeoutMs: 500 });

    const stats = sink.stats();
    expect(stats.timedOut).toBe(1);
    // The row the pre-fix log line would have called lost was recorded. That gap is the whole defect.
    expect(stats.lateRecorded).toBe(2);
    expect(stats.written).toBe(2);
    expect(calls).toHaveLength(1);
  });

  it("retries a refused batch once and then spills it rather than hammering a struggling server", async () => {
    const { sink, appended } = fakeDeadLetter();
    const { write, calls } = controllableWrite({ fail: true });
    const writer = createRunAuditSinkWriter({ write, deadLetter: sink, env: FAST_ENV });

    writer.submit(row("task:refused-a"));
    writer.submit(row("task:refused-b"));
    writer.submit(row("task:refused-c"));
    await writer.flush({ timeoutMs: 500 });

    expect(calls).toHaveLength(2); // the attempt plus exactly one retry, never a backoff loop
    const stats = writer.stats();
    expect(stats.batchFailures).toBe(1);
    expect(stats.written).toBe(0);
    expect(stats.spilledToDeadLetter).toBe(3);
    expect(appended).toHaveLength(3);
    expect(appended[0]!.row.mutationType).toBe("task:refused-a");
    expect(appended[0]!.reason).toContain("batch-refused");
  });

  it("spills the newest row at the queue ceiling and never grows past it", async () => {
    const { sink, appended } = fakeDeadLetter();
    const { write, calls } = controllableWrite({ hang: true });
    const writer = createRunAuditSinkWriter({
      write,
      deadLetter: sink,
      // A window wide enough that nothing drains while the burst is measured.
      env: { ...FAST_ENV, FUSION_RUN_AUDIT_SINK_QUEUE_MAX: "3", FUSION_RUN_AUDIT_SINK_FLUSH_WINDOW_MS: "10000" },
    });

    const results = Array.from({ length: 6 }, (_, index) => writer.submit(row(`task:burst-${index}`)));
    const depthDuringBurst = writer.stats();
    // Spilling is asynchronous; a turn of the loop settles the fake sink without draining the queue.
    await new Promise((resolve) => setImmediate(resolve));

    expect(results.slice(0, 3).every((result) => result.queued && !result.spilled)).toBe(true);
    expect(results.slice(3).every((result) => result.accepted && !result.queued && result.spilled)).toBe(true);
    expect(depthDuringBurst.queueDepth).toBe(3);
    expect(depthDuringBurst.queuePeak).toBe(3);
    expect(appended).toHaveLength(3);
    expect(appended[0]!.row.mutationType).toBe("task:burst-3");
    expect(calls).toHaveLength(0);
    // Clearing the armed window keeps a live timer from outliving the case.
    await writer.stop({ timeoutMs: 1 });
  });

  it("spills what a shutdown drain could not write", async () => {
    const { sink, appended } = fakeDeadLetter();
    const { write } = controllableWrite({ hang: true });
    const writer = createRunAuditSinkWriter({
      write,
      deadLetter: sink,
      env: { ...FAST_ENV, FUSION_RUN_AUDIT_SINK_FLUSH_WINDOW_MS: "10000" },
    });

    for (let index = 0; index < 4; index += 1) writer.submit(row(`task:pending-${index}`));
    const startedAt = Date.now();
    await writer.stop({ timeoutMs: 30 });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(writer.stats().spilledToDeadLetter).toBe(4);
    expect(appended.map((entry) => entry.reason)).toContain("shutdown-drain");
    // A stopped writer stops accepting, so the caller keeps its own bounded-write behavior.
    expect(writer.submit(row("task:after-stop")).accepted).toBe(false);
  });

  it("contains a write that throws synchronously without surfacing anything to the submitter", async () => {
    const { sink, appended } = fakeDeadLetter();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const writer = createRunAuditSinkWriter({
        write: (() => {
          throw new Error("sink exploded synchronously");
        }) as never,
        deadLetter: sink,
        env: FAST_ENV,
      });

      writer.submit(row("task:hostile"));
      await writer.flush({ timeoutMs: 200 });

      expect(writer.stats().batchFailures).toBe(1);
      expect(writer.stats().spilledToDeadLetter).toBe(1);
      expect(appended).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("assigns a stable id at submit so a spill and its replay are the same row", async () => {
    const { sink, appended } = fakeDeadLetter();
    const { write } = controllableWrite({ fail: true });
    const writer = createRunAuditSinkWriter({ write, deadLetter: sink, env: FAST_ENV });

    writer.submit({ ...row("task:stable-id", "wi-stable"), id: "row-id-from-submit" });
    await writer.flush({ timeoutMs: 200 });

    expect(appended[0]!.row.id).toBe("row-id-from-submit");
    expect(appended[0]!.row.target).toBe("wi-stable");
  });

  it("summarizes moved counters at most once per interval", async () => {
    const warnings: string[] = [];
    let clock = 0;
    const { write } = controllableWrite();
    const writer = createRunAuditSinkWriter({
      write,
      env: FAST_ENV,
      now: () => clock,
      log: { warn: (message) => { warnings.push(message); } },
    });

    for (let index = 0; index < 5; index += 1) writer.submit(row(`task:summary-${index}`));
    clock += 5_000;
    for (let index = 0; index < 5; index += 1) writer.submit(row(`task:summary-late-${index}`));
    clock += 120_000;
    for (let index = 0; index < 5; index += 1) writer.submit(row(`task:summary-next-window-${index}`));

    const summaries = warnings.filter((line) => line.includes("[run-audit] sink accepted="));
    expect(summaries.length).toBeLessThanOrEqual(2);
    expect(summaries.length).toBeGreaterThan(0);
    await writer.flush({ timeoutMs: 200 });
  });

  it("reports pid and every accounting counter the diagnostics surface reads", async () => {
    const { write } = controllableWrite();
    const writer = createRunAuditSinkWriter({ write, env: FAST_ENV });
    writer.submit(row());
    await writer.flush({ timeoutMs: 200 });

    expect(writer.stats()).toEqual({
      pid: process.pid,
      accepted: 1,
      coalesced: 0,
      written: 1,
      batches: 1,
      batchFailures: 0,
      queueDepth: 0,
      queuePeak: 1,
      timedOut: 0,
      lateRecorded: 0,
      slowWrites: 0,
      maxLatencyMs: expect.any(Number),
      spilledToDeadLetter: 0,
      deadLetterSuppressed: 0,
    });
  });
});
