export type RoomOpenPhase =
  | "select"
  | "cache-hit"
  | "members-fetch"
  | "messages-fetch"
  | "hydrate"
  | "sse-reconnect-refresh"
  | "complete";

export interface RoomOpenTimer {
  mark: (phase: RoomOpenPhase) => void;
  complete: (extra?: Record<string, number | string | boolean>) => void;
  cancel: () => void;
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function isDiagnosticsEnabled(): boolean {
  try {
    if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
      return true;
    }
  } catch {
    // noop
  }

  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("kb-debug-room-open") === "1";
    }
  } catch {
    // noop
  }

  return false;
}

export function startRoomOpenTimer(roomId: string, opts?: { warm: boolean }): RoomOpenTimer {
  const enabled = isDiagnosticsEnabled();
  const warm = opts?.warm === true;
  const startedAt = nowMs();
  const marks = new Map<RoomOpenPhase, number>();
  let finalized = false;
  let cancelled = false;

  const complete = (extra?: Record<string, number | string | boolean>) => {
    if (!enabled || finalized || cancelled) {
      finalized = true;
      return;
    }

    finalized = true;
    marks.set("complete", nowMs());

    const entries = Array.from(marks.entries()).sort((a, b) => a[1] - b[1]);
    let previous = startedAt;
    const phases: Partial<Record<RoomOpenPhase, number>> = {};
    for (const [phase, timestamp] of entries) {
      phases[phase] = Math.max(0, timestamp - previous);
      previous = timestamp;
    }

    const totalMs = Math.max(0, nowMs() - startedAt);

    try {
      console.debug("[room-open]", {
        roomId,
        warm,
        totalMs,
        phases,
        ...(extra ?? {}),
      });
    } catch {
      // noop
    }
  };

  return {
    mark(phase) {
      if (finalized || cancelled || !enabled || marks.has(phase)) {
        return;
      }
      marks.set(phase, nowMs());
    },
    complete,
    cancel() {
      cancelled = true;
      finalized = true;
    },
  };
}
