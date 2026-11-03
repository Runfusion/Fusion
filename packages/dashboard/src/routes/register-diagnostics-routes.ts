import { isResumeTrigger } from "../shared/resume-triggers.js";
import type { ApiRouteRegistrar } from "./types.js";

let resumeRingCap = 5_000;
const ACCEPT_CAP = 100;
const DETAIL_CAP_BYTES = 4 * 1024;

type ResumeEvent = {
  ts: string;
  view: string;
  trigger: string;
  projectId?: string;
  gapMs?: number;
  replayAttempted: boolean;
  replayFromEventId?: number | null;
  lastEventId?: number | null;
  sseChannel?: string;
  reason?: string;
  detail?: Record<string, unknown>;
};

const resumeEvents: ResumeEvent[] = [];
let droppedCount = 0;

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (Number.isNaN(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function isJsonSafe(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function validateEvent(event: unknown): event is ResumeEvent {
  if (!event || typeof event !== "object") return false;
  const candidate = event as Record<string, unknown>;
  if (!isIsoDate(candidate.ts)) return false;
  if (typeof candidate.view !== "string" || candidate.view.length === 0 || candidate.view.length > 64) return false;
  if (!isResumeTrigger(candidate.trigger)) return false;
  if (typeof candidate.replayAttempted !== "boolean") return false;

  if (candidate.detail !== undefined) {
    if (!isJsonSafe(candidate.detail)) return false;
    if (Buffer.byteLength(JSON.stringify(candidate.detail), "utf8") > DETAIL_CAP_BYTES) return false;
  }

  return true;
}

function appendEvents(events: ResumeEvent[]): void {
  resumeEvents.push(...events);
  if (resumeEvents.length > resumeRingCap) {
    const overflow = resumeEvents.length - resumeRingCap;
    droppedCount += overflow;
    resumeEvents.splice(0, overflow);
  }
}

export const registerDiagnosticsRoutes: ApiRouteRegistrar = (ctx) => {
  const { router } = ctx;

  router.post("/diagnostics/resume-events", async (req, res) => {
    try {
      await ctx.getProjectContext(req);

      const body = req.body as { events?: unknown };
      const events = body?.events;

      if (!Array.isArray(events) || events.length > ACCEPT_CAP) {
        res.status(400).json({ error: "Invalid events payload" });
        return;
      }

      if (!events.every(validateEvent)) {
        res.status(400).json({ error: "Invalid resume event entry" });
        return;
      }

      appendEvents(events);
      res.json({ ok: true, accepted: events.length });
    } catch (error) {
      ctx.rethrowAsApiError(error, "Failed to store resume diagnostics events");
    }
  });

  router.get("/diagnostics/resume-events", async (req, res) => {
    try {
      await ctx.getProjectContext(req);

      const limit = Math.max(1, Math.min(Number(req.query.limit ?? 100) || 100, resumeRingCap));
      const since = typeof req.query.since === "string" ? Date.parse(req.query.since) : NaN;
      const view = typeof req.query.view === "string" ? req.query.view : undefined;

      let filtered = resumeEvents;
      if (!Number.isNaN(since)) {
        filtered = filtered.filter((event) => Date.parse(event.ts) >= since);
      }
      if (view) {
        filtered = filtered.filter((event) => event.view === view);
      }

      const events = filtered.slice(-limit);
      const droppedSinceLastRead = droppedCount;
      droppedCount = 0;

      res.json({ events, droppedSinceLastRead });
    } catch (error) {
      ctx.rethrowAsApiError(error, "Failed to read resume diagnostics events");
    }
  });

  /*
  FNXC:RunAuditSink 2026-09-30 (RUFU-453):
  The run-audit sink's own account, because "is telemetry being lost?" was previously answerable only by
  grepping a 20 MB log for a line whose meaning depended on which lane emitted it. Every accepted row must
  be accounted as written, spilled, or suppressed, so the counters are the deliverable: `spilled` above
  zero or a non-empty `deadLetter` is real loss, while `timedOut`/`lateRecorded` on a live `queueDepth`
  mean a slow pool that has not cost anything yet.

  This reports the DAEMON process's queue on `ctx.store` — the writer is per store instance, and an
  operator asking about the queue is asking about the process that holds it. A host with no writer (the
  `FUSION_RUN_AUDIT_BUFFERED=0` kill switch, a non-durable backend, or a store that has not emitted yet)
  answers `available: false` beside `buffered`, so "switched off" and "nothing queued" stay distinguishable
  instead of both reading as zeroes.

  The spill file's size and row count come from the writer's in-memory accounting, so this route never
  parses the backup on a poll; `?rows=1` is the explicit, bounded read for an operator who wants the
  actual rows.
  */
  router.get("/diagnostics/run-audit-sink", async (req, res) => {
    try {
      const sinkStore = ctx.store as unknown as {
        getRunAuditSinkStats?: () => Record<string, unknown> | null;
        getRunAuditSinkDeadLetterStats?: () => { path: string; bytes: number; rows: number; suppressed: number; writeFailures: number } | null;
        readRunAuditSinkDeadLetter?: () => Promise<{ path: string; bytes: number; rows: unknown[]; malformed: number; truncated: boolean }>;
      };
      const stats = sinkStore.getRunAuditSinkStats?.() ?? null;
      const deadLetterStats = sinkStore.getRunAuditSinkDeadLetterStats?.() ?? null;
      const wantRows = req.query.rows === "1" || req.query.rows === "true";

      if (!stats) {
        res.json({
          available: false,
          buffered: process.env.FUSION_RUN_AUDIT_BUFFERED !== "0",
          pid: process.pid,
          deadLetter: deadLetterStats,
        });
        return;
      }

      const rows = wantRows ? await sinkStore.readRunAuditSinkDeadLetter?.() : undefined;
      res.json({
        available: true,
        buffered: true,
        ...stats,
        deadLetter: deadLetterStats
          ? { ...deadLetterStats, ...(rows ? { malformed: rows.malformed, truncated: rows.truncated, entries: rows.rows } : {}) }
          : null,
      });
    } catch (error) {
      ctx.rethrowAsApiError(error, "Failed to read run-audit sink diagnostics");
    }
  });
};

export function __resetResumeDiagnosticsForTests(): void {
  resumeEvents.length = 0;
  droppedCount = 0;
  resumeRingCap = 5_000;
}

export function __setResumeDiagnosticsCapForTests(cap: number): void {
  resumeRingCap = Math.max(1, Math.floor(cap));
}
