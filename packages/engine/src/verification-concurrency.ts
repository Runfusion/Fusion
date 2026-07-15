/*
FNXC:VerificationConcurrency 2026-07-15-03:35:
Multiple in-progress tasks each calling fn_run_verification (often `pnpm verify:fast` / full typecheck+build) pegged CPU by running several monorepo compiles in parallel. Cap concurrent verification subprocesses project-wide so task concurrency can stay higher without stacking heavy builds. Default limit is 1; operators raise maxConcurrentVerifications when the machine has spare cores.
*/
import { AgentSemaphore, PRIORITY_EXECUTE } from "./concurrency.js";

let limit = 1;
const verificationSemaphore = new AgentSemaphore(() => limit);

/**
 * Update the process-wide verification slot limit (live-readable by the semaphore).
 * Values are clamped to a minimum of 1.
 */
export function setMaxConcurrentVerifications(next: number): void {
  if (!Number.isFinite(next) || next < 1) {
    limit = 1;
    return;
  }
  limit = Math.floor(next);
}

/** Current verification concurrency limit (after clamping). */
export function getMaxConcurrentVerifications(): number {
  return verificationSemaphore.limit;
}

/**
 * Run `fn` while holding one verification slot. Waiters queue FIFO at execute priority.
 */
export async function withVerificationSlot<T>(fn: () => Promise<T>): Promise<T> {
  await verificationSemaphore.acquire(PRIORITY_EXECUTE);
  try {
    return await fn();
  } finally {
    verificationSemaphore.release();
  }
}

/** Test/diagnostic access to the underlying semaphore. */
export function getVerificationSemaphore(): AgentSemaphore {
  return verificationSemaphore;
}
