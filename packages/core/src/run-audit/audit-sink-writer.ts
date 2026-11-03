/**
 * Bounded run-audit sink writer — the queue that lives BELOW the best-effort seam.
 *
 * FNXC:RunAudit 2026-09-30 (RUFU-453):
 * Measured 2026-09-30 21:35Z: 1332 `[run-audit] timed out recording` lines in the last 20 MB of the
 * production redeploy log. Every one of those was a fire-and-forget emit that gave up after the 2000 ms
 * seam bound while the database was merely busy. The audit insert travels the runtime pool, whose
 * default ceiling is `DEFAULT_POOL_MAX = 3` (`postgres/connection.ts`), so any three concurrent
 * lifecycle writes put an audit INSERT in a queue it cannot predict — and a best-effort row that
 * loses a race against live task traffic is a row nobody can find afterwards.
 *
 * The seam's contract is unchanged and stays exactly what FN-9172/FN-9175/FN-9177 wrote: never block,
 * never fail, never delay the caller, no retry, no queue, no backoff INSIDE the seam. This module is
 * where that deferral was always meant to land: an accept-and-return queue with one bounded drain in
 * flight, batched writes, a bounded coalescing window, and every row accounted for as accepted,
 * coalesced, written, timed out, late-recorded, or spilled to the dead letter. Nothing is silently
 * dropped, because an unmeasurable loss is what made the incident unreadable.
 *
 * The queue is deliberately NOT a retry mechanism for a saturated database. A failed batch is retried
 * ONCE immediately and then spilled to disk; retrying the same insert into a struggling server is the
 * exact doubling-of-pool-pressure that produced the original loss.
 */
import { randomUUID } from "node:crypto";

import type { RunAuditEventInput } from "../types.js";

/** Rows buffered before the newest one is spilled to the dead letter. Bounded memory, never unbounded. */
export const RUN_AUDIT_SINK_QUEUE_MAX = 1000;
/** Rows per INSERT round-trip: ~25x fewer pool checkouts than one transaction per row. */
export const RUN_AUDIT_SINK_BATCH_MAX = 50;
/** Coalescing window — how long the drain waits to gather a batch before writing. */
export const RUN_AUDIT_SINK_FLUSH_WINDOW_MS = 25;
/** Per-attempt write bound, the same floor the seam itself uses (`CORE_RUN_AUDIT_EMIT_TIMEOUT_MS`). */
export const RUN_AUDIT_SINK_WRITE_BOUND_MS = 2_000;
/** A successful write slower than this is worth a line of log; the loss starts as a slow write. */
export const RUN_AUDIT_SINK_SLOW_WRITE_MS = 1_000;
/** Rate limit for the slow-write warn and the periodic counter summary. */
export const RUN_AUDIT_SINK_LOG_INTERVAL_MS = 60_000;
/** Hard ceiling on the final drain so `close()` can never be held open by a dead database. */
export const RUN_AUDIT_SINK_SHUTDOWN_DRAIN_MS = 2_000;

/** One buffered audit row, already shaped for the `project.run_audit_events` insert. */
export type RunAuditSinkRow = {
  /** Assigned at submit time so a spill and a replay land as the SAME row (`(project_id, id)` is the PK). */
  id: string;
  timestamp: string;
  taskId: string | null;
  agentId: string;
  runId: string;
  domain: string;
  mutationType: string;
  target: string;
  metadata: Record<string, unknown> | null;
};

/** Every row that passed through the writer, in one of its exactly-three terminal states. */
export type RunAuditSinkStats = {
  /** Submitted and held in the queue or in flight. */
  accepted: number;
  /** Submitted into a window that was already open (no extra queue check-out). */
  coalesced: number;
  /** Landed in `run_audit_events`. */
  written: number;
  batches: number;
  batchFailures: number;
  queueDepth: number;
  queuePeak: number;
  /** Batches whose write passed the write bound while still in flight. Never a claim of loss. */
  timedOut: number;
  /** Batches that passed the write bound and then actually landed — the row the old log line lied about. */
  lateRecorded: number;
  slowWrites: number;
  maxLatencyMs: number;
  spilledToDeadLetter: number;
  deadLetterSuppressed: number;
  pid: number;
};

/** The spill target. Implemented by `run-audit-dead-letter.ts`, faked in tests. */
export type RunAuditSinkDeadLetter = {
  append(row: RunAuditSinkRow, reason: string): Promise<{ written: boolean; suppressed: boolean }>;
  stats(): { path: string; bytes: number; rows: number; suppressed?: number; writeFailures?: number };
  close?(): Promise<void>;
};

export type RunAuditSinkWriter = {
  submit(event: RunAuditSinkEvent): { accepted: boolean; queued: boolean; spilled: boolean; queueDepth: number };
  flush(options?: { timeoutMs?: number }): Promise<void>;
  stats(): RunAuditSinkStats;
  /*
  FNXC:RunAuditSink 2026-09-30 (RUFU-453):
  Kept OUT of `stats()` so a caller that only wants the counters never pays for the spill file's first
  `stat`, and so the diagnostics surface can answer "how full is the backup?" from in-memory numbers
  instead of re-reading up to the byte cap on every dashboard poll. Reading the rows themselves is a
  separate, deliberate act (`readRunAuditSinkDeadLetter`).
  */
  deadLetterStats(): { path: string; bytes: number; rows: number; suppressed: number; writeFailures: number } | null;
  stop(options?: { timeoutMs?: number }): Promise<void>;
};

/**
 * An emit as the seam hands it down. `id` is optional and normally absent: every emitter in the fleet
 * calls with the ordinary `RunAuditEventInput`, and the writer assigns the primary key itself.
 */
export type RunAuditSinkEvent = RunAuditEventInput & { id?: string };

function boundFrom(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function emptyStats(pid: number): RunAuditSinkStats {
  return {
    accepted: 0,
    coalesced: 0,
    written: 0,
    batches: 0,
    batchFailures: 0,
    queueDepth: 0,
    queuePeak: 0,
    timedOut: 0,
    lateRecorded: 0,
    slowWrites: 0,
    maxLatencyMs: 0,
    spilledToDeadLetter: 0,
    deadLetterSuppressed: 0,
    pid,
  };
}

/** Resolves `false` once `ms` elapses; resolves `true` early when `cancelSignal` settles. */
function withinWindow(ms: number, work: Promise<unknown>): Promise<{ settled: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) resolve({ settled: false });
    }, ms);
    timer.unref?.();
    void work.then(
      () => {
        settled = true;
        clearTimeout(timer);
        resolve({ settled: true });
      },
      () => {
        settled = true;
        clearTimeout(timer);
        resolve({ settled: true });
      },
    );
  });
}

/**
 * Builds the process-wide run-audit sink. The caller supplies the real write (a batched insert against
 * the durable backend) and optionally the spill file; the writer itself holds no database knowledge,
 * which is what lets it be tested with a fake write and no server at all.
 */
export function createRunAuditSinkWriter(deps: {
  write: (rows: RunAuditSinkRow[]) => Promise<unknown>;
  deadLetter?: RunAuditSinkDeadLetter;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: { warn: (message: string) => void };
}): RunAuditSinkWriter {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const queueMax = boundFrom(env.FUSION_RUN_AUDIT_SINK_QUEUE_MAX, RUN_AUDIT_SINK_QUEUE_MAX, 1);
  const batchMax = boundFrom(env.FUSION_RUN_AUDIT_SINK_BATCH_MAX, RUN_AUDIT_SINK_BATCH_MAX, 1);
  const flushWindowMs = boundFrom(env.FUSION_RUN_AUDIT_SINK_FLUSH_WINDOW_MS, RUN_AUDIT_SINK_FLUSH_WINDOW_MS, 0);
  const writeBoundMs = boundFrom(env.FUSION_RUN_AUDIT_SINK_WRITE_BOUND_MS, RUN_AUDIT_SINK_WRITE_BOUND_MS, 1);

  const stats = emptyStats(process.pid);
  const queue: RunAuditSinkRow[] = [];
  let draining: Promise<void> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /*
  Seeded below any reachable clock rather than at 0: a throttle that begins "just after the last
  emit" would swallow the FIRST summary of every process whose clock starts near zero, which is what
  an injected test clock does.
  */
  let lastLogAtMs = Number.NEGATIVE_INFINITY;
  let countersAtLastLog = snapshotCounters();

  function snapshotCounters() {
    return { accepted: stats.accepted, written: stats.written, spilled: stats.spilledToDeadLetter };
  }

  /** One rate-limited channel: a sustained bad minute produces a handful of lines, not one per row. */
  function logThrottled(message: string): void {
    const at = now();
    if (at - lastLogAtMs < RUN_AUDIT_SINK_LOG_INTERVAL_MS) return;
    lastLogAtMs = at;
    deps.log?.warn(message);
  }

  /** Periodic accounting, but only when counters actually moved — an idle process stays silent. */
  function maybeSummarize(): void {
    const current = snapshotCounters();
    const moved =
      current.accepted !== countersAtLastLog.accepted
      || current.written !== countersAtLastLog.written
      || current.spilled !== countersAtLastLog.spilled;
    if (!moved) return;
    countersAtLastLog = current;
    logThrottled(
      `[run-audit] sink accepted=${stats.accepted} written=${stats.written}`
        + ` queued=${queue.length} timedOut=${stats.timedOut} late=${stats.lateRecorded}`
        + ` spilled=${stats.spilledToDeadLetter}`,
    );
  }

  async function spill(rows: RunAuditSinkRow[], reason: string): Promise<void> {
    if (!deps.deadLetter) {
      // No spill target means the only honest accounting left is the counter plus one log line.
      stats.deadLetterSuppressed += rows.length;
      logThrottled(`[run-audit] sink ${reason}: ${rows.length} row(s) had no dead-letter target`);
      return;
    }
    for (const row of rows) {
      try {
        const result = await deps.deadLetter.append(row, reason);
        if (result.written) stats.spilledToDeadLetter += 1;
        if (result.suppressed) stats.deadLetterSuppressed += 1;
      } catch {
        // A spill that cannot be written is itself accounted; it must never surface to the caller.
        stats.deadLetterSuppressed += 1;
      }
    }
  }

  async function writeBatch(batch: RunAuditSinkRow[]): Promise<void> {
    const startedAt = now();
    // Invoke before awaiting: a sink that throws synchronously is a rejection, not an escaped error.
    const attempt = (async () => deps.write(batch))();
    const settled = (await withinWindow(writeBoundMs, attempt)).settled;

    if (!settled) {
      // The write is still in flight. Do NOT abandon the rows and do NOT issue a second insert — a
      // duplicate write into the server that is already slow is what made the original loss. Keep
      // awaiting the SAME promise; if it lands, the row was recorded after all.
      stats.timedOut += 1;
      logThrottled(
        `[run-audit] sink write exceeded ${writeBoundMs}ms (batch=${batch.length}`
          + ` queued=${queue.length}) — still in flight, not counted as lost`,
      );
      await attempt.then(
        () => undefined,
        () => undefined,
      );
    }

    const latencyMs = Math.max(0, now() - startedAt);
    stats.maxLatencyMs = Math.max(stats.maxLatencyMs, latencyMs);
    if (latencyMs >= RUN_AUDIT_SINK_SLOW_WRITE_MS) {
      stats.slowWrites += 1;
      logThrottled(`[run-audit] sink slow write ${latencyMs}ms batch=${batch.length} queued=${queue.length}`);
    }

    let landed = false;
    let failure: unknown = null;
    try {
      await attempt;
      landed = true;
    } catch (error) {
      landed = false;
      failure = error;
    }

    if (landed) {
      stats.batches += 1;
      stats.written += batch.length;
      if (latencyMs > writeBoundMs) stats.lateRecorded += batch.length;
      return;
    }

    stats.batchFailures += 1;
    // One immediate retry, no backoff queue: a second identical insert is cheap, an unbounded retry
    // loop against a struggling server is the harm this module exists to remove.
    let recovered = false;
    try {
      await deps.write(batch);
      recovered = true;
    } catch {
      recovered = false;
    }
    if (recovered) {
      stats.batches += 1;
      stats.written += batch.length;
      return;
    }

    stats.batches += 1;
    const reason = failure instanceof Error ? failure.name : "batch-rejected";
    await spill(batch, `batch-refused:${reason}`);
  }

  async function drain(): Promise<void> {
    if (draining) return draining;
    draining = (async () => {
      while (queue.length > 0) {
        const batch = queue.splice(0, batchMax);
        await writeBatch(batch);
      }
    })().finally(() => {
      draining = null;
    });
    return draining;
  }

  function armFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void drain().catch(() => undefined);
    }, flushWindowMs);
    flushTimer.unref?.();
  }

  function clearFlush(): void {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  return {
    submit(event: RunAuditSinkEvent) {
      const row: RunAuditSinkRow = {
        id: typeof event.id === "string" && event.id.length > 0 ? event.id : randomUUID(),
        timestamp: event.timestamp ?? new Date(now()).toISOString(),
        taskId: event.taskId ?? null,
        agentId: event.agentId,
        runId: event.runId,
        domain: String(event.domain),
        mutationType: String(event.mutationType),
        target: event.target,
        metadata: event.metadata ?? null,
      };

      if (stopped) return { accepted: false, queued: false, spilled: false, queueDepth: 0 };

      if (queue.length >= queueMax) {
        /*
        Overflow policy: the NEWEST row spills and the already-buffered rows keep their place. Reversed
        it looks tidier but loses the rows the drain was closest to writing, and a burst would then
        evict exactly the rows most likely to have landed on the next pass.
        */
        stats.accepted += 1;
        void spill([row], "queue-overflow");
        return { accepted: true, queued: false, spilled: true, queueDepth: queue.length };
      }

      const coalescing = queue.length > 0;
      queue.push(row);
      stats.accepted += 1;
      if (coalescing) stats.coalesced += 1;
      stats.queueDepth = queue.length;
      stats.queuePeak = Math.max(stats.queuePeak, queue.length);

      // A full batch writes now rather than waiting out the coalescing window for nothing.
      if (queue.length >= batchMax) {
        clearFlush();
        void drain().catch(() => undefined);
      } else {
        armFlush();
      }
      maybeSummarize();
      return { accepted: true, queued: true, spilled: false, queueDepth: queue.length };
    },

    async flush(options = {}) {
      clearFlush();
      const deadline = now() + (options.timeoutMs ?? writeBoundMs);
      while (true) {
        const remainingMs = deadline - now();
        if (remainingMs <= 0) return;
        /*
        A batch leaves the queue the moment it is spliced, so an empty queue is NOT evidence that every
        accepted row has landed — one may be mid-INSERT. Waiting on the queue alone returned a flush that
        had written nothing yet, which is why both must be settled before flush resolves.
        */
        const inFlight = draining;
        if (queue.length === 0 && !inFlight) return;
        const work = queue.length > 0 ? drain() : inFlight!.catch(() => undefined);
        const { settled } = await withinWindow(remainingMs, work);
        if (!settled) return;
      }
    },

    stats() {
      return { ...stats, queueDepth: queue.length, pid: process.pid };
    },

    deadLetterStats() {
      const spill = deps.deadLetter;
      if (!spill) return null;
      const sink = spill.stats();
      return {
        path: sink.path,
        bytes: sink.bytes,
        rows: sink.rows,
        suppressed: sink.suppressed ?? 0,
        writeFailures: sink.writeFailures ?? 0,
      };
    },

    async stop(options = {}) {
      stopped = true;
      clearFlush();
      const budgetMs = options.timeoutMs ?? RUN_AUDIT_SINK_SHUTDOWN_DRAIN_MS;
      if (draining) await withinWindow(budgetMs, draining.catch(() => undefined));
      const remaining = queue.splice(0, queue.length);
      if (remaining.length > 0) await spill(remaining, "shutdown-drain");
      stats.queueDepth = 0;
      try {
        await deps.deadLetter?.close?.();
      } catch {
        // Closing the spill file is best-effort; shutdown never waits on it.
      }
    },
  };
}
