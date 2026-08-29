export type TraceEntry = {
  ts: string;
  source: string;
  event: string;
  detail: Record<string, unknown>;
};

const TRACE_CAP = 200;
const traces: TraceEntry[] = [];

export function pushTrace(source: string, event: string, detail: Record<string, unknown>): void {
  traces.push({
    ts: new Date().toISOString(),
    source,
    event,
    detail,
  });

  if (traces.length > TRACE_CAP) {
    traces.splice(0, traces.length - TRACE_CAP);
  }
}

export function getTraces(): TraceEntry[] {
  return [...traces];
}

export function clearTraces(): void {
  traces.length = 0;
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
  window.__fusionDebug.dashboardTraces = {
    get: getTraces,
    clear: clearTraces,
  };
}
