/**
 * FNXC:EngineDiagnostics 2026-08-10-08:59:
 * The executor pre-dispatch gates (unmet dependencies, ephemeral-agents-off) re-run on EVERY dispatch attempt for a
 * blocked task, but they only change state on the first one — every later pass re-queues an already-queued task and
 * re-logged the same line. On the default log level that is pure per-poll chatter: a single stuck dependency pushed a
 * repeating "executor dispatch blocked" line into the TUI log pane until it drowned out real events (same failure mode
 * the scheduler already avoids with its `wasNodeBlocked`/`wasNodeDispatchValidationBlocked` sets).
 *
 * So: log the block at `log()` level ONCE per task per distinct reason signature, and emit repeats under `debug()`
 * (opt in with `FUSION_DEBUG=executor`). A changed reason — e.g. a different unmet dependency — is a new signature and
 * logs again, so operators still see the transition. Callers clear the marker when the gate passes so the next block of
 * the same task is reported afresh; the map is keyed by task id and is bounded by the set of currently-blocked tasks.
 *
 * FNXC:EngineDiagnostics 2026-08-10-17:13:
 * The suppression itself is now the shared `createRepeatSuppressedLog` primitive — the scheduler's symbol-lock renewal
 * needed the identical behaviour, so the mechanism lives in one place while this module stays the executor's instance.
 */
import type { Logger } from "../logger.js";
import { createRepeatSuppressedLog } from "../util/repeat-suppressed-log.js";

const dispatchBlockLog = createRepeatSuppressedLog();

/**
 * Log a dispatch-block message at `log()` level only when `signature` differs from the last one logged for `taskId`;
 * otherwise emit it at `debug()` level.
 */
export function logDispatchBlockedOnce(logger: Logger, taskId: string, signature: string, message: string): void {
  dispatchBlockLog.logOnce(logger, taskId, signature, message);
}

/** Forget a task's last-logged block signature so its next block is reported at `log()` level again. */
export function clearDispatchBlockedLogState(taskId: string): void {
  dispatchBlockLog.clear(taskId);
}

/** Test-only: drop all remembered signatures. */
export function resetDispatchBlockedLogState(): void {
  dispatchBlockLog.reset();
}
