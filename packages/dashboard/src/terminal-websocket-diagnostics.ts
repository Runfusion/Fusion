import { basename, normalize, sep } from "node:path";
import { createRuntimeLogger, type RuntimeLogger } from "./runtime-logger.js";

export interface TerminalWebSocketDiagnostics {
  scopeResolutionFailed(context: { projectId?: string; error: unknown }): void;
  crossProjectCwdRejected(context: {
    sessionId: string;
    projectId?: string;
    sessionCwd: string;
    scopedRootDir: string;
  }): void;
  staleReconnect(context: { sessionId: string; idleMs: number; staleThresholdMs: number }): void;
  heartbeatMissed(context: { sessionId: string; missedPongs: number; maxMissedPongs: number }): void;
  heartbeatTerminating(context: { sessionId: string; missedPongs: number; maxMissedPongs: number }): void;
  ptyExit(context: { sessionId: string; exitCode: number | null; idleSeconds: number }): void;
  staleEvictionFailed(context: { error: unknown }): void;
  mounted(context: { path: string }): void;
}

/**
 * Creates a bounded identifier suitable for diagnostics.
 *
 * Contract:
 * - Never emits the full raw session id
 * - Preserves enough entropy to correlate events in a single incident
 * - Output format is stable for test assertions
 */
export function toSessionTag(sessionId: string): string {
  const normalized = sessionId.trim();
  if (normalized.length <= 8) {
    return `${normalized}#${normalized.length}`;
  }
  return `${normalized.slice(0, 4)}…${normalized.slice(-4)}#${normalized.length}`;
}

/**
 * Redacts an absolute filesystem path while preserving mismatch debugging clues.
 *
 * Contract:
 * - Removes leading absolute path segments
 * - Includes only the last two segments + depth metadata
 * - Stable string formatting for test assertions
 */
export function toRedactedPathHint(pathValue: string): string {
  const normalized = normalize(pathValue);
  const segments = normalized.split(sep).filter(Boolean);
  if (segments.length === 0) {
    return "<empty>";
  }

  const tail = segments.slice(-2).join("/");
  return `<redacted>/${tail} (depth:${segments.length})`;
}

function normalizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      error: error.message,
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
    };
  }
  const fallback = String(error);
  return {
    error: fallback,
    errorMessage: fallback,
  };
}

export function createTerminalWebSocketDiagnostics(runtimeLogger?: RuntimeLogger): TerminalWebSocketDiagnostics {
  const logger = runtimeLogger?.child("terminal") ?? createRuntimeLogger("terminal");

  return {
    scopeResolutionFailed({ projectId, error }) {
      logger.error("Failed to resolve project scope", {
        projectId,
        ...normalizeError(error),
      });
    },
    crossProjectCwdRejected({ sessionId, projectId, sessionCwd, scopedRootDir }) {
      logger.warn("Rejected terminal session outside scoped project root", {
        sessionTag: toSessionTag(sessionId),
        projectId,
        sessionCwdHint: toRedactedPathHint(sessionCwd),
        scopedRootHint: toRedactedPathHint(scopedRootDir),
        sessionCwdBase: basename(sessionCwd),
        scopedRootBase: basename(scopedRootDir),
      });
    },
    staleReconnect({ sessionId, idleMs, staleThresholdMs }) {
      logger.warn("Terminal reconnect may target stale PTY session", {
        sessionTag: toSessionTag(sessionId),
        idleMs,
        staleThresholdMs,
      });
    },
    heartbeatMissed({ sessionId, missedPongs, maxMissedPongs }) {
      logger.info("Missed terminal websocket pong", {
        sessionTag: toSessionTag(sessionId),
        missedPongs,
        maxMissedPongs,
      });
    },
    heartbeatTerminating({ sessionId, missedPongs, maxMissedPongs }) {
      logger.warn("Terminating terminal websocket after missed pong threshold", {
        sessionTag: toSessionTag(sessionId),
        missedPongs,
        maxMissedPongs,
      });
    },
    ptyExit({ sessionId, exitCode, idleSeconds }) {
      logger.info("Terminal PTY exited", {
        sessionTag: toSessionTag(sessionId),
        exitCode,
        idleSeconds,
      });
    },
    staleEvictionFailed({ error }) {
      logger.error("Stale session eviction failed", {
        ...normalizeError(error),
      });
    },
    mounted({ path }) {
      logger.info("WebSocket server mounted", {
        path,
      });
    },
  };
}
