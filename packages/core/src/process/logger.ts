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
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const LOG_LEVEL_MARKER_PREFIX = "\u0000fnlvl=";
const LOG_LEVEL_MARKER_SUFFIX = "\u0000";

function withSeverityMarker(level: "info" | "warn" | "error", payload: string): string {
  return `${LOG_LEVEL_MARKER_PREFIX}${level}${LOG_LEVEL_MARKER_SUFFIX}${payload}`;
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
 */
export function createLogger(prefix: string): Logger {
  const tag = `[${prefix}]`;
  return {
    log(message: string, ...args: unknown[]) {
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
