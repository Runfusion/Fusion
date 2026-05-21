import { pushTrace } from "./dashboardTraceBuffer";

export type ResumeTrigger =
  | "visibility"
  | "pageshow"
  | "sse-error"
  | "sse-reconnect"
  | "sse-open"
  | "remount"
  | "route-active"
  | "route-inactive"
  | "project-context-change";

export type ResumeEvent = {
  ts: string;
  view: string;
  trigger: ResumeTrigger;
  projectId?: string;
  gapMs?: number;
  replayAttempted: boolean;
  replayFromEventId?: number | null;
  lastEventId?: number | null;
  sseChannel?: string;
  reason?: string;
  detail?: Record<string, unknown>;
};

const RESUME_CAP = 500;
const POST_BATCH_CAP = 25;

const resumeEvents: ResumeEvent[] = [];
const pendingBatch: ResumeEvent[] = [];
const lastActivityByView = new Map<string, number>();
let lastActivityGlobal: number | undefined;
let flushScheduled = false;
let enabled = true;

function nowTs(now: number): string {
  return new Date(now).toISOString();
}

function enqueueFlush(): void {
  if (flushScheduled || pendingBatch.length === 0 || typeof window === "undefined") {
    return;
  }
  flushScheduled = true;

  const schedule = (cb: () => void) => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(cb);
      return;
    }
    window.setTimeout(cb, 0);
  };

  schedule(() => {
    flushScheduled = false;
    void flushPendingBatch();
  });
}

async function flushPendingBatch(): Promise<void> {
  if (pendingBatch.length === 0 || typeof window === "undefined" || typeof globalThis.fetch !== "function") {
    return;
  }

  const events = pendingBatch.splice(0, POST_BATCH_CAP);

  try {
    await globalThis.fetch("/api/diagnostics/resume-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });
  } catch {
    // swallow instrumentation failures
  }

  if (pendingBatch.length > 0) {
    enqueueFlush();
  }
}

export function getResumeEvents(): ResumeEvent[] {
  return [...resumeEvents];
}

export function clearResumeEvents(): void {
  resumeEvents.length = 0;
  pendingBatch.length = 0;
  flushScheduled = false;
  lastActivityByView.clear();
  lastActivityGlobal = undefined;
}

export function setResumeInstrumentationEnabled(nextEnabled: boolean): void {
  enabled = nextEnabled;
}

export function recordResumeEvent(
  event: Omit<ResumeEvent, "ts" | "gapMs"> & { now?: number },
): ResumeEvent {
  const now = event.now ?? Date.now();
  const previousByView = lastActivityByView.get(event.view);
  const previousGlobal = lastActivityGlobal;
  const baseline = previousByView ?? previousGlobal;

  const stampedEvent: ResumeEvent = {
    ...event,
    ts: nowTs(now),
    gapMs: baseline !== undefined ? Math.max(0, now - baseline) : undefined,
  };

  delete (stampedEvent as { now?: number }).now;

  lastActivityByView.set(event.view, now);
  lastActivityGlobal = now;

  if (!enabled) {
    return stampedEvent;
  }

  pushTrace("resumeInstrumentation", event.trigger, stampedEvent as unknown as Record<string, unknown>);

  resumeEvents.push(stampedEvent);
  if (resumeEvents.length > RESUME_CAP) {
    resumeEvents.splice(0, resumeEvents.length - RESUME_CAP);
  }

  pendingBatch.push(stampedEvent);
  enqueueFlush();

  return stampedEvent;
}

declare global {
  interface Window {
    __fusionDebug?: {
      dashboardTraces?: {
        get: () => unknown[];
        clear: () => void;
      };
      resumeInstrumentation?: {
        get: () => unknown[];
        clear: () => void;
        setEnabled: (nextEnabled: boolean) => void;
      };
    };
  }
}

if (typeof window !== "undefined") {
  window.__fusionDebug ??= {};
  window.__fusionDebug.resumeInstrumentation = {
    get: getResumeEvents,
    clear: clearResumeEvents,
    setEnabled: setResumeInstrumentationEnabled,
  };
}
