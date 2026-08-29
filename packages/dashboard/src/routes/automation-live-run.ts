import type { Request, Response } from "express";
import { ApiError, notFound } from "../api-error.js";
import { SessionEventBuffer, writeSSEEvent } from "../sse-buffer.js";
import type { ScopeValue } from "./types.js";

export const DEFAULT_AUTOMATION_TIMEOUT_MS = 5 * 60 * 1000;
export const AUTOMATION_MAX_BUFFER = 1024 * 1024;
export const AUTOMATION_MAX_OUTPUT = 10240;
const AUTOMATION_LIVE_RUN_TTL_MS = 60 * 1000;
const AUTOMATION_LIVE_EVENT_CAPACITY = 200;

type AutomationLiveRunStatus = "running" | "complete" | "error";
type AutomationLiveEvent = { type: string; data?: unknown };
export type AutomationLiveRunCallbacks = {
  onStep?: (data: Record<string, unknown>) => void;
  onText?: (delta: string) => void;
  onToolStart?: (name: string, args?: Record<string, unknown>) => void;
  onToolEnd?: (name: string, isError: boolean, result?: unknown) => void;
};

type AutomationLiveRunRecord = {
  runId: string;
  scheduleId: string;
  status: AutomationLiveRunStatus;
  buffer: SessionEventBuffer;
  listeners: Set<(event: AutomationLiveEvent, eventId: number) => void>;
  output: string;
  cleanupTimer?: NodeJS.Timeout;
  /*
   * FNXC:AutomationLiveOutput 2026-07-07-00:00 (FN-7652):
   * Wall-clock start time (ms since epoch) used solely to decide whether a runId-less GET
   * .../run/stream request should auto-attach to this run (see getForAutoAttach). Distinct from the
   * result's own ISO `startedAt`/`completedAt` timestamps, which describe the automation's execution
   * window, not stream-attach freshness.
   */
  startedAt: number;
};

function createAutomationRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `automation-run-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function capAutomationLiveText(current: string, delta: string): { next: string; delta: string } {
  if (!delta) return { next: current, delta: "" };
  const remaining = AUTOMATION_MAX_OUTPUT - current.length;
  if (remaining <= 0) return { next: current, delta: "" };
  const marker = "\n[output truncated]";
  const cappedDelta = delta.length > remaining
    ? remaining > marker.length
      ? `${delta.slice(0, remaining - marker.length)}${marker}`
      : delta.slice(0, remaining)
    : delta;
  return { next: `${current}${cappedDelta}`, delta: cappedDelta };
}

function previewAutomationLiveValue(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.length <= 1000) return value;
    return `${text.slice(0, 1000)}…`;
  } catch {
    return "[unserializable]";
  }
}

/*
FNXC:AutomationLiveOutput 2026-06-26-00:00:
Manual automation runs need replayable live output without changing the POST /run result contract. Keep events in memory by runId, let schedule streams wait for the next run, and expire completed buffers so missed EventSource clients do not leak registry entries.
*/
class AutomationLiveRunRegistry {
  private readonly runs = new Map<string, AutomationLiveRunRecord>();
  private readonly latestRunBySchedule = new Map<string, string>();
  private readonly scheduleStartListeners = new Map<string, Set<(run: AutomationLiveRunRecord) => void>>();

  /*
   * FNXC:AutomationLiveOutput 2026-07-07-00:00 (FN-7652):
   * A runId-less GET .../run/stream auto-attach must not pick up a run that finished well before this
   * specific trigger (e.g. the previous manual run for the same schedule/routine, still within the
   * AUTOMATION_LIVE_RUN_TTL_MS replay window). Auto-attaching to that stale run replays its own
   * (unrelated) terminal `complete`/`error` event onto a brand-new trigger's stream, which is exactly
   * the false "Run failed"-for-a-success-run bug (FN-7652). Bound how old a *finished* run may be and
   * still be auto-attached; a still-`running` run has no age limit since it IS the in-flight trigger.
   */
  private static readonly AUTO_ATTACH_STALE_WINDOW_MS = 10_000;

  start(scheduleId: string, runId = createAutomationRunId()): AutomationLiveRunRecord {
    const run: AutomationLiveRunRecord = {
      runId,
      scheduleId,
      status: "running",
      buffer: new SessionEventBuffer(AUTOMATION_LIVE_EVENT_CAPACITY),
      listeners: new Set(),
      output: "",
      startedAt: Date.now(),
    };
    this.runs.set(runId, run);
    this.latestRunBySchedule.set(scheduleId, runId);
    this.broadcast(runId, { type: "run", data: { runId, scheduleId, status: "running" } });
    const starters = this.scheduleStartListeners.get(scheduleId);
    if (starters) {
      for (const listener of [...starters]) listener(run);
    }
    return run;
  }

  get(runId: string | undefined, scheduleId: string): AutomationLiveRunRecord | undefined {
    if (runId) {
      const run = this.runs.get(runId);
      return run?.scheduleId === scheduleId ? run : undefined;
    }
    const latestRunId = this.latestRunBySchedule.get(scheduleId);
    return latestRunId ? this.runs.get(latestRunId) : undefined;
  }

  /*
   * FNXC:AutomationLiveOutput 2026-07-07-00:00 (FN-7652):
   * Used by GET .../run/stream instead of `get()` when the caller supplied no explicit runId. Returns
   * the latest run for the schedule/routine only when it is still live, or finished recently enough
   * (AUTO_ATTACH_STALE_WINDOW_MS) to plausibly be the run this very request is racing against.
   * Otherwise returns undefined so the caller falls back to `subscribeToScheduleStart` and waits for
   * its own fresh `run` event, instead of replaying an unrelated older run's terminal outcome.
   */
  getForAutoAttach(scheduleId: string): AutomationLiveRunRecord | undefined {
    const latestRunId = this.latestRunBySchedule.get(scheduleId);
    if (!latestRunId) return undefined;
    const run = this.runs.get(latestRunId);
    if (!run) return undefined;
    if (run.status === "running") return run;
    if (Date.now() - run.startedAt < AutomationLiveRunRegistry.AUTO_ATTACH_STALE_WINDOW_MS) return run;
    return undefined;
  }

  getBufferedEvents(runId: string, lastEventId = 0) {
    return this.runs.get(runId)?.buffer.getEventsSince(lastEventId) ?? [];
  }

  subscribe(runId: string, listener: (event: AutomationLiveEvent, eventId: number) => void): () => void {
    const run = this.runs.get(runId);
    if (!run) return () => {};
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  subscribeToScheduleStart(scheduleId: string, listener: (run: AutomationLiveRunRecord) => void): () => void {
    let listeners = this.scheduleStartListeners.get(scheduleId);
    if (!listeners) {
      listeners = new Set();
      this.scheduleStartListeners.set(scheduleId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.scheduleStartListeners.delete(scheduleId);
    };
  }

  broadcast(runId: string, event: AutomationLiveEvent): number | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const eventId = run.buffer.push(event.type, JSON.stringify(event.data ?? {}));
    for (const listener of [...run.listeners]) listener(event, eventId);
    return eventId;
  }

  appendText(runId: string, delta: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const capped = capAutomationLiveText(run.output, delta);
    run.output = capped.next;
    if (capped.delta) this.broadcast(runId, { type: "output", data: { text: capped.delta } });
  }

  complete(runId: string, result: import("@fusion/core").AutomationRunResult): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = result.success ? "complete" : "error";
    this.broadcast(runId, { type: result.success ? "complete" : "error", data: result.success ? { runId, result } : { runId, result, message: result.error ?? "Automation run failed" } });
    this.scheduleCleanup(run);
  }

  fail(runId: string, message: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = "error";
    this.broadcast(runId, { type: "error", data: { runId, message } });
    this.scheduleCleanup(run);
  }

  private scheduleCleanup(run: AutomationLiveRunRecord): void {
    if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
    run.cleanupTimer = setTimeout(() => {
      this.runs.delete(run.runId);
      if (this.latestRunBySchedule.get(run.scheduleId) === run.runId) {
        this.latestRunBySchedule.delete(run.scheduleId);
      }
    }, AUTOMATION_LIVE_RUN_TTL_MS);
    run.cleanupTimer.unref?.();
  }
}

export const automationLiveRuns = new AutomationLiveRunRegistry();
export const MANUAL_RUN_AI_SYSTEM_PROMPT = [
  "You are an AI automation agent executing a scheduled task.",
  "You may use the coding tools selected for this automation step; follow any tool restrictions exactly.",
  "Execute the prompt precisely and return concise, structured results.",
  "When analyzing code or data, provide actionable summaries.",
].join("\n");

export function createAutomationLiveRunCallbacks(runId: string): AutomationLiveRunCallbacks {
  return {
    onStep: (data) => automationLiveRuns.broadcast(runId, { type: "step", data: { runId, ...data } }),
    onText: (delta) => automationLiveRuns.appendText(runId, delta),
    onToolStart: (name, args) => automationLiveRuns.broadcast(runId, {
      type: "tool",
      data: { runId, status: "started", name, args: previewAutomationLiveValue(args) },
    }),
    onToolEnd: (name, isError, result) => automationLiveRuns.broadcast(runId, {
      type: "tool",
      data: { runId, status: "completed", name, isError, result: previewAutomationLiveValue(result) },
    }),
  };
}


/** Creates the shared automation/routine live SSE stream handler without duplicating generic SSE parsing. */
export function createAutomationRunStreamHandlerFactory(deps: {
  parseScopeParam(req: Request): ScopeValue | undefined;
  rethrowAsApiError(error: unknown, fallbackMessage?: string): never;
  parseLastEventId(req: Request): number | undefined;
  replayBufferedSSE(res: Response, bufferedEvents: Array<{ id: number; event: string; data: string }>): boolean;
}) {
  const { parseScopeParam, rethrowAsApiError, parseLastEventId, replayBufferedSSE } = deps;
  return function makeRunStreamHandler<TStore, TEntity extends { id: string; scope?: ScopeValue }>(config: {
    resolveStore: (req: Request, scope: ScopeValue | undefined) => TStore;
    getEntity: (store: TStore, id: string) => Promise<TEntity>;
    notFoundMessage: string;
  }): (req: Request, res: Response) => Promise<void> {
    const { resolveStore, getEntity, notFoundMessage } = config;
    return async (req: Request, res: Response) => {
      const scope = parseScopeParam(req);
      const store = resolveStore(req, scope);
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      try {
        const entity = await getEntity(store, id);
        if (scope && entity.scope !== scope) {
          throw notFound(notFoundMessage);
        }

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        res.write(": connected\n\n");

        const requestedRunId = typeof req.query.runId === "string" ? req.query.runId : undefined;
        const lastEventId = parseLastEventId(req);
        let unsubscribeRun: (() => void) | undefined;
        let unsubscribeStart: (() => void) | undefined;

        const attachRun = (run: AutomationLiveRunRecord) => {
          const buffered = automationLiveRuns.getBufferedEvents(run.runId, lastEventId ?? 0);
          if (!replayBufferedSSE(res, buffered)) {
            res.end();
            return;
          }
          if (run.status !== "running") {
            res.end();
            return;
          }
          unsubscribeRun = automationLiveRuns.subscribe(run.runId, (event, eventId) => {
            if (!writeSSEEvent(res, event.type, JSON.stringify(event.data ?? {}), eventId)) {
              unsubscribeRun?.();
              return;
            }
            if (event.type === "complete" || event.type === "error") {
              unsubscribeRun?.();
              res.end();
            }
          });
        };

        // FNXC:AutomationLiveOutput 2026-07-07-00:00 (FN-7652): no explicit runId means "attach me to
        // this request's own run" — use getForAutoAttach so a stale finished run from before this
        // trigger isn't mistaken for it (see AutomationLiveRunRegistry.getForAutoAttach).
        const existingRun = requestedRunId
          ? automationLiveRuns.get(requestedRunId, entity.id)
          : automationLiveRuns.getForAutoAttach(entity.id);
        if (existingRun) {
          attachRun(existingRun);
        } else if (requestedRunId) {
          writeSSEEvent(res, "error", JSON.stringify({ message: "Live run not found or expired", runId: requestedRunId }));
          res.end();
        } else {
          unsubscribeStart = automationLiveRuns.subscribeToScheduleStart(entity.id, (run) => {
            unsubscribeStart?.();
            attachRun(run);
          });
        }

        req.on("close", () => {
          unsubscribeRun?.();
          unsubscribeStart?.();
        });
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          throw err;
        }
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw notFound(notFoundMessage);
        }
        rethrowAsApiError(err);
      }
    };
  }

}
