import type { ApiRouteRegistrar } from "./types.js";

let resumeRingCap = 5_000;
const ACCEPT_CAP = 100;
const DETAIL_CAP_BYTES = 4 * 1024;

const triggers = new Set([
  "visibility",
  "pageshow",
  "sse-error",
  "sse-reconnect",
  "sse-open",
  "remount",
  "route-active",
  "route-inactive",
  "project-context-change",
]);

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
  if (typeof candidate.trigger !== "string" || !triggers.has(candidate.trigger)) return false;
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
};

export function __resetResumeDiagnosticsForTests(): void {
  resumeEvents.length = 0;
  droppedCount = 0;
  resumeRingCap = 5_000;
}

export function __setResumeDiagnosticsCapForTests(cap: number): void {
  resumeRingCap = Math.max(1, Math.floor(cap));
}
