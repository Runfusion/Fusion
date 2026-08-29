/**
 * Lightweight structured logger for the `@fusion/core` package.
 *
 * Usage:
 * ```ts
 * import { createLogger } from "./logger.js";
 * const log = createLogger("my-module");
 * log.log("hello");   // → console.error("[my-module] hello")
 * log.warn("oops");   // → console.warn("[my-module] oops")
 * log.error("fail");  // → console.error("[my-module] fail")
 * ```
 *
 * Core subsystems should use this utility rather than calling `console.*`
 * directly so diagnostics stay consistent and easy to suppress/match in tests.
 */

export interface Logger {
  log(message: string, ...args: unknown[]): void;
  /**
   * Steady-state chatter. Suppressed unless the subsystem is opted in via
   * `FUSION_DEBUG` (see `isDebugEnabled`). Aligned with `@fusion/engine` logger.
   */
  debug(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const LOG_LEVEL_MARKER_PREFIX = "\u0000fnlvl=";
const LOG_LEVEL_MARKER_SUFFIX = "\u0000";

function withSeverityMarker(level: "info" | "warn" | "error", payload: string): string {
  return `${LOG_LEVEL_MARKER_PREFIX}${level}${LOG_LEVEL_MARKER_SUFFIX}${payload}`;
}

/*
FNXC:EngineDiagnostics 2026-07-26-09:45:
Core process-supervisor emits `spawned pid=…` on every supervised child (fn_run_verification, scripts, etc.), which filled the TUI log pane. `debug()` matches the engine logger: off by default, opt-in via FUSION_DEBUG=process-supervisor (or 1/all/*).
*/
function isDebugEnabled(prefix: string): boolean {
  const raw = process.env.FUSION_DEBUG?.trim();
  if (!raw) return false;
  if (raw === "1" || raw === "true" || raw === "all" || raw === "*") return true;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .includes(prefix);
}

/**
 * Create a structured logger that prefixes every message with `[prefix]`.
 *
 * @param prefix - Short subsystem name, e.g. "plugin-loader".
 * @returns A `Logger` whose output is prefixed and sent to stderr for normal
 *          logs and errors. Keeping logs off stdout prevents command/test
 *          output consumers from receiving Fusion execution chatter.
 *
 *          The logger prepends an internal control-character severity marker
 *          so dashboard TUI console-capture can preserve info/warn/error
 *          semantics even when `log()` is transported via `console.error`.
 *
 *          `debug()` is gated on `FUSION_DEBUG` and re-reads the env var per
 *          call so long-lived processes can toggle without recreating loggers.
 */
export function createLogger(prefix: string): Logger {
  const tag = `[${prefix}]`;
  return {
    log(message: string, ...args: unknown[]) {
      console.error(withSeverityMarker("info", `${tag} ${message}`), ...args);
    },
    debug(message: string, ...args: unknown[]) {
      if (!isDebugEnabled(prefix)) return;
      console.error(withSeverityMarker("info", `${tag} ${message}`), ...args);
    },
    warn(message: string, ...args: unknown[]) {
      console.warn(withSeverityMarker("warn", `${tag} ${message}`), ...args);
    },
    error(message: string, ...args: unknown[]) {
      console.error(withSeverityMarker("error", `${tag} ${message}`), ...args);
    },
  };
}
