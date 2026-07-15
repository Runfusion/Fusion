/*
FNXC:VerificationConcurrency 2026-07-15-03:35:
Multiple in-progress tasks each calling fn_run_verification (often `pnpm verify:fast` / full typecheck+build) pegged CPU by running several monorepo compiles in parallel. Cap concurrent verification subprocesses project-wide so task concurrency can stay higher without stacking heavy builds. Default limit is 1; operators raise maxConcurrentVerifications when the machine has spare cores.

FNXC:VerificationConcurrency 2026-07-15-08:20:
Greptile P1/P2: (1) clamp 1–8 so programmatic settings cannot open 50 slots; (2) do not re-set the process limit on every verification start (multi-project races last-writer-wins) — wire the limit from engine settings load/update only; (3) honor AbortSignal while queued so cancelled merge/verification does not block the slot queue.
*/
import { AgentSemaphore, PRIORITY_EXECUTE } from "./concurrency.js";

/** Hard ceiling matching the Scheduling UI max. */
export const MAX_CONCURRENT_VERIFICATIONS_HARD_CAP = 8;
/** Floor — at least one verification can always run. */
export const MIN_CONCURRENT_VERIFICATIONS = 1;

let limit = MIN_CONCURRENT_VERIFICATIONS;
const verificationSemaphore = new AgentSemaphore(() => limit);

/**
 * Clamp a raw setting/API value into the enforced verification concurrency range.
 */
export function clampMaxConcurrentVerifications(next: number): number {
  if (!Number.isFinite(next)) return MIN_CONCURRENT_VERIFICATIONS;
  return Math.min(
    MAX_CONCURRENT_VERIFICATIONS_HARD_CAP,
    Math.max(MIN_CONCURRENT_VERIFICATIONS, Math.floor(next)),
  );
}

/**
 * Update the process-wide verification slot limit from engine settings load/update.
 * Values are clamped to 1–8. Do not call this on every verification start.
 */
export function setMaxConcurrentVerifications(next: number): void {
  limit = clampMaxConcurrentVerifications(next);
}

/** Current verification concurrency limit (after clamping). */
export function getMaxConcurrentVerifications(): number {
  return verificationSemaphore.limit;
}

/**
 * Run `fn` while holding one verification slot. Waiters queue at execute priority.
 * When `signal` aborts while queued, the waiter is removed and the promise rejects
 * with AbortError so cancelled work does not block the queue.
 */
export async function withVerificationSlot<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  await verificationSemaphore.acquire(PRIORITY_EXECUTE, signal);
  try {
    if (signal?.aborted) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    return await fn();
  } finally {
    verificationSemaphore.release();
  }
}

/** Test/diagnostic access to the underlying semaphore. */
export function getVerificationSemaphore(): AgentSemaphore {
  return verificationSemaphore;
}
