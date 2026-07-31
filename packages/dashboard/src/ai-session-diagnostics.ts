import { createLogger } from "@fusion/core";
/**
 * Shared AI-Session Diagnostics Helper
 *
 * Provides a reusable diagnostics contract for planning-like AI session flows.
 * Modules such as `planning.ts`, `mission-interview.ts`, `milestone-slice-interview.ts`,
 * and `subtask-breakdown.ts` can use this helper to converge on one consistent
 * diagnostics pattern.
 *
 * ## Design Goals
 *
 * 1. **Scoped Structured Logging** — All log methods accept a structured context
 *    payload (typed object) in addition to a message. This enables precise test
 *    assertions without relying on string matching against `console.*` output.
 *
 * 2. **Log-and-Continue Semantics** — Non-fatal paths (cleanup, broadcast,
 *    rehydration) must not throw. The `nonfatal()` helper wraps potentially
 *    failing operations, logs diagnostics on failure, and continues execution.
 *
 * 3. **Test Injection Hooks** — A module-level logger can be swapped via
 *    `setDiagnosticsSink()`. Tests can capture diagnostics in-memory and assert
 *    on level, message fragment, scope, and context fields. No global
 *    `console.*` monkey-patching required.
 *
 * ## Usage
 *
 * ```ts
 * import { createSessionDiagnostics, setDiagnosticsSink, resetDiagnosticsSink } from "./ai-session-diagnostics.js";
 *
 * const diagnostics = createSessionDiagnostics("planning");
 *
 * // Structured logging with context
 * diagnostics.info("Session created", { sessionId: "abc" });
 * diagnostics.warn("Rate limit approaching", { ip: "1.2.3.4", count: 4 });
 * diagnostics.error("Agent initialization failed", { error: err });
 *
 * // Non-fatal wrapper for best-effort operations
 * nonfatal(
 *   () => riskyOperation(),
 *   diagnostics,
 *   "Cleanup failed",
 *   { operation: "dispose", sessionId: "abc" }
 * );
 * ```
 *
 * ## Test Hooks
 *
 * ```ts
 * import { setDiagnosticsSink, resetDiagnosticsSink } from "./ai-session-diagnostics.js";
 *
 * const logged: LogEntry[] = [];
 * setDiagnosticsSink({
 *   log: (level, scope, message, context) => logged.push({ level, scope, message, context }),
 * });
 *
 * // ... run test ...
 *
 * expect(logged).toContainEqual(expect.objectContaining({
 *   level: "error",
 *   scope: "planning",
 *   message: "Agent initialization failed",
 *   context: expect.objectContaining({ sessionId: "abc" }),
 * }));
 *
 * resetDiagnosticsSink();
 * ```
 *
 * ## Contract Guarantees
 *
 * - All methods are non-throwing (safe to call in catch blocks)
 * - Default runtime uses `console.log/warn/error` with scope prefix
 * - Structured context is forwarded to the sink unchanged
 * - `nonfatal()` never rethrows — callers always continue
 */

import { randomUUID } from "node:crypto";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Log level for diagnostics entries.
 */
export type DiagnosticsLevel = "info" | "warn" | "error";

/**
 * Structured context payload attached to a log entry.
 * Consumers can attach any serializable fields relevant to the operation.
 */
export interface DiagnosticsContext {
  /** The session or operation identifier when applicable */
  sessionId?: string;
  /** The client IP address for rate-limiting diagnostics */
  ip?: string;
  /** Error object when logging failures */
  error?: unknown;
  /** Operation name for cleanup/broadcast/rehydration failures */
  operation?: string;
  /** Any additional context fields */
  [key: string]: unknown;
}

/**
 * Log entry captured by a custom diagnostics sink.
 * This is the canonical shape for test assertions.
 */
export interface LogEntry {
  /** Log level */
  level: DiagnosticsLevel;
  /** Scope tag (e.g., "planning", "mission-interview") */
  scope: string;
  /** Human-readable message fragment */
  message: string;
  /** Structured context payload */
  context: DiagnosticsContext;
  /** Timestamp when the entry was recorded */
  timestamp: Date;
}

/**
 * A custom diagnostics sink for intercepting log output.
 * Used by tests to capture diagnostics in-memory without global console spies.
 */
export interface DiagnosticsSink {
  /**
   * Called for every log event.
   * @param level - Log level (info/warn/error)
   * @param scope - Scope tag (e.g., "planning", "mission-interview")
   * @param message - Human-readable message fragment
   * @param context - Structured context payload
   */
  (level: DiagnosticsLevel, scope: string, message: string, context: DiagnosticsContext): void;
}

/**
 * Scoped diagnostics interface returned by `createSessionDiagnostics()`.
 * Provides typed `info`, `warn`, and `error` methods with context payload support.
 */
export interface SessionDiagnostics {
  /** The scope tag associated with this diagnostics instance */
  readonly scope: string;

  /**
   * Log an informational diagnostic.
   * @param message - Human-readable message fragment
   * @param context - Structured context payload (partial, merged with defaults)
   */
  info(message: string, context?: Partial<DiagnosticsContext>): void;

  /**
   * Log a warning diagnostic.
   * @param message - Human-readable message fragment
   * @param context - Structured context payload (partial, merged with defaults)
   */
  warn(message: string, context?: Partial<DiagnosticsContext>): void;

  /**
   * Log an error diagnostic.
   * @param message - Human-readable message fragment
   * @param context - Structured context payload (partial, merged with defaults)
   */
  error(message: string, context?: Partial<DiagnosticsContext>): void;

  /**
   * Log an error from a caught exception.
   * Extracts the error message and stacks for structured context.
   * @param message - Human-readable message fragment
   * @param error - The caught error
   * @param context - Additional structured context
   */
  errorFromException(
    message: string,
    error: unknown,
    context?: Partial<DiagnosticsContext>
  ): void;
}

// ── Module-Level Sink ───────────────────────────────────────────────────────

/**
 * The current diagnostics sink.
 * Defaults to `defaultSink` which outputs to console with scope prefix.
 */
let _sink: DiagnosticsSink = defaultSink;

/**
 * Default sink: outputs to console with scope prefix.
 * All methods are non-throwing (safe to call even if console is mocked).
 */
function defaultSink(level: DiagnosticsLevel, scope: string, message: string, context: DiagnosticsContext): void {
  const log = createLogger(scope);
  try {
    switch (level) {
      case "info":
        log.log(message, context);
        break;
      case "warn":
        log.warn(message, context);
        break;
      case "error":
        log.error(message, context);
        break;
    }
  } catch {
    // Intentionally swallow — diagnostics must never throw
  }
}

/**
 * Set a custom diagnostics sink (test hook).
 *
 * When a sink is injected, all diagnostics from all scopes route through it.
 * This allows tests to capture diagnostics without global `console.*` spies.
 *
 * Pass `null` or `undefined` to reset to the default console sink.
 *
 * @param sink - Custom sink function, or null/undefined to reset
 *
 * @example
 * ```ts
 * const logged: LogEntry[] = [];
 * setDiagnosticsSink((level, scope, message, context) => {
 *   logged.push({ level, scope, message, context, timestamp: new Date() });
 * });
 *
 * // ... tests ...
 *
 * resetDiagnosticsSink();
 * ```
 */
export function setDiagnosticsSink(sink: DiagnosticsSink | null | undefined): void {
  _sink = sink ?? defaultSink;
}

/**
 * Get the current diagnostics sink.
 * @internal - exposed for advanced test scenarios
 */
export function getDiagnosticsSink(): DiagnosticsSink {
  return _sink;
}

/**
 * Reset the diagnostics sink to the default console sink.
 * Call this in test teardown to restore default behavior.
 */
export function resetDiagnosticsSink(): void {
  _sink = defaultSink;
}

// ── Session Diagnostics Factory ─────────────────────────────────────────────

/**
 * Create a scoped diagnostics instance.
 *
 * The returned `SessionDiagnostics` has typed `info`, `warn`, and `error`
 * methods that forward structured context to the module-level sink.
 *
 * @param scope - Short scope tag (e.g., "planning", "mission-interview")
 * @returns A scoped diagnostics instance
 *
 * @example
 * ```ts
 * const diagnostics = createSessionDiagnostics("planning");
 * diagnostics.info("Session created", { sessionId: "abc" });
 * diagnostics.error("Agent init failed", { error: err });
 * ```
 */
export function createSessionDiagnostics(scope: string): SessionDiagnostics {
  return {
    scope,
    info(message, context = {}) {
      emit("info", scope, message, context);
    },
    warn(message, context = {}) {
      emit("warn", scope, message, context);
    },
    error(message, context = {}) {
      emit("error", scope, message, context);
    },
    errorFromException(message, error, context = {}) {
      const errorContext: DiagnosticsContext = {
        ...context,
        error: serializeError(error),
      };
      emit("error", scope, message, errorContext);
    },
  };
}

function emit(
  level: DiagnosticsLevel,
  scope: string,
  message: string,
  context: Partial<DiagnosticsContext>
): void {
  const fullContext: DiagnosticsContext = {
    ...context,
    _emittedAt: new Date().toISOString(),
    _diagnosticsId: randomUUID(),
  };

  try {
    _sink(level, scope, message, fullContext);
  } catch {
    // Intentionally swallow — diagnostics must never throw
  }
}

// ── Non-Fatal Helper ───────────────────────────────────────────────────────

/**
 * Execute an operation and log a diagnostic if it fails.
 *
 * This is the standard pattern for best-effort paths (cleanup, broadcast,
 * rehydration) where failures should be surfaced as diagnostics but must NOT
 * propagate as exceptions.
 *
 * The wrapped function's return value is returned on success.
 * On failure, `undefined` is returned after logging.
 *
 * @param operation - The potentially-failing operation
 * @param logger - The scoped diagnostics instance to use
 * @param message - Human-readable message for the failure diagnostic
 * @param context - Structured context for the failure diagnostic
 * @returns The operation's return value, or `undefined` on failure
 *
 * @example
 * ```ts
 * // Best-effort cleanup — never throws
 * const disposed = nonfatal(
 *   () => agent.session.dispose(),
 *   diagnostics,
 *   "Error disposing agent",
 *   { sessionId }
 * );
 * // disposed is the return value, or undefined if failed
 * ```
 *
 * @example
 * ```ts
 * // Best-effort broadcast — continue even if subscriber throws
 * nonfatal(
 *   () => callback(event),
 *   diagnostics,
 *   "Error broadcasting to client",
 *   { sessionId }
 * );
 * // Execution continues regardless of callback failure
 * ```
 */
export function nonfatal<T>(
  operation: () => T,
  logger: SessionDiagnostics,
  message: string,
  context: Partial<DiagnosticsContext>
): T | undefined {
  try {
    return operation();
  } catch (error) {
    logger.errorFromException(message, error, context);
    return undefined;
  }
}

/**
 * Execute an async operation and log a diagnostic if it fails.
 *
 * Same semantics as `nonfatal()` but for `async` operations.
 * Returns `undefined` on failure after logging.
 *
 * @param operation - The potentially-failing async operation
 * @param logger - The scoped diagnostics instance to use
 * @param message - Human-readable message for the failure diagnostic
 * @param context - Structured context for the failure diagnostic
 * @returns The operation's resolved value, or `undefined` on failure
 *
 * @example
 * ```ts
 * const result = await nonfatalAsync(
 *   () => riskyAsyncOperation(),
 *   diagnostics,
 *   "Rehydration failed",
 *   { sessionId }
 * );
 * // result is the resolved value, or undefined if failed/threw
 * ```
 */
export async function nonfatalAsync<T>(
  operation: () => Promise<T>,
  logger: SessionDiagnostics,
  message: string,
  context: Partial<DiagnosticsContext>
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    logger.errorFromException(message, error, context);
    return undefined;
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────

/**
 * Serialize an error for structured context.
 * Handles Error objects, strings, and unknown values.
 */
function serializeError(error: unknown): { message: string; stack?: string } | string {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    try {
      const obj = error as Record<string, unknown>;
      const message = obj.message;
      // If the object has a meaningful message property, use it
      if (typeof message === "string" && message !== "[object Object]") {
        return {
          message,
          stack: typeof obj.stack === "string" ? obj.stack : undefined,
        };
      }
      // For objects without a message property, try to extract useful info
      // by serializing the object (but only for non-default representations)
      const keys = Object.keys(obj).filter(k => k !== "stack");
      if (keys.length > 0) {
        // Return a summary of the object's key-value pairs
        const summary = keys
          .slice(0, 5) // Limit to 5 keys to avoid verbosity
          .map(k => `${k}: ${JSON.stringify(obj[k])}`)
          .join(", ");
        return {
          message: `{${summary}}`,
          stack: typeof obj.stack === "string" ? obj.stack : undefined,
        };
      }
    } catch {
      // Fallback if object inspection fails
    }
  }
  return String(error);
}
