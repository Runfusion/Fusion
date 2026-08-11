/**
 * FNXC:EngineDiagnostics 2026-08-10-17:13:
 * Shared primitive for "this condition is re-evaluated every poll but only the TRANSITION is news".
 * Engine sweeps (scheduler poll, executor pre-dispatch gates) re-run the same checks on every pass, so a condition that
 * persists — an unmet dependency, a lost symbol lock, a failing lookup — used to reprint an identical line at default
 * level forever and bury real events in the TUI log pane (the same failure mode the 2026-07-15 routing/capacity sweep
 * fixed by hand with per-subsystem `was*Blocked` sets).
 *
 * `logOnce` logs at `log()`/`warn()` the first time a key is seen with a given signature, and drops identical repeats to
 * `debug()` (opt in per subsystem via `FUSION_DEBUG`). A CHANGED signature is a real transition and logs at full level
 * again. It returns whether it logged at full level, so callers can gate a companion side effect — a `store.logEntry`
 * write that would otherwise append the same row every poll — on the same first-occurrence decision.
 *
 * The logger is passed per call rather than captured, so a shared instance stays usable from call sites that log through
 * different subsystem loggers. Each call site builds its own instance, so keyspaces (task ids) cannot collide across
 * subsystems, and callers clear a key when the condition resolves so its next occurrence is reported afresh. State is
 * bounded by the set of keys currently in the condition.
 */
import type { Logger } from "../logger.js";

export type RepeatSuppressedLog = {
  /**
   * Emit `message` at `level` when `signature` differs from the last one logged for `key`; otherwise emit at `debug()`.
   *
   * @returns `true` when the message was logged at `level` (i.e. this is a new or changed condition).
   */
  logOnce(logger: Logger, key: string, signature: string, message: string, level?: "log" | "warn"): boolean;
  /** Forget a key so its next occurrence logs at full level again. */
  clear(key: string): void;
  /** Drop all remembered signatures (engine stop / tests). */
  reset(): void;
};

export function createRepeatSuppressedLog(): RepeatSuppressedLog {
  const lastSignatureByKey = new Map<string, string>();
  return {
    logOnce(logger, key, signature, message, level = "log") {
      if (lastSignatureByKey.get(key) === signature) {
        logger.debug(message);
        return false;
      }
      lastSignatureByKey.set(key, signature);
      logger[level](message);
      return true;
    },
    clear(key) {
      lastSignatureByKey.delete(key);
    },
    reset() {
      lastSignatureByKey.clear();
    },
  };
}
