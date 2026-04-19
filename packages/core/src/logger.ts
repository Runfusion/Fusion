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

/**
 * Create a structured logger that prefixes every message with `[prefix]`.
 *
 * @param prefix - Short subsystem name, e.g. "plugin-loader".
 * @returns A `Logger` whose output is prefixed and sent to stderr for normal
 *          logs and errors. Keeping logs off stdout prevents command/test
 *          output consumers from receiving Fusion execution chatter.
 */
export function createLogger(prefix: string): Logger {
  const tag = `[${prefix}]`;
  return {
    log(message: string, ...args: unknown[]) {
      console.error(`${tag} ${message}`, ...args);
    },
    warn(message: string, ...args: unknown[]) {
      console.warn(`${tag} ${message}`, ...args);
    },
    error(message: string, ...args: unknown[]) {
      console.error(`${tag} ${message}`, ...args);
    },
  };
}
