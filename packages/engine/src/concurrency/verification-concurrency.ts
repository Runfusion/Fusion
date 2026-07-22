/*
FNXC:VerificationConcurrency 2026-07-15-03:35:
Multiple in-progress tasks each calling fn_run_verification (often `pnpm verify:fast` / full typecheck+build) pegged CPU by running several monorepo compiles in parallel. Cap concurrent verification subprocesses project-wide so task concurrency can stay higher without stacking heavy builds. Default limit is 1; operators raise maxConcurrentVerifications when the machine has spare cores.

FNXC:VerificationConcurrency 2026-07-15-08:20:
Greptile P1/P2: (1) clamp 1–8 so programmatic settings cannot open 50 slots; (2) do not re-set the process limit on every verification start (multi-project races last-writer-wins) — wire the limit from engine settings load/update only; (3) honor AbortSignal while queued so cancelled merge/verification does not block the slot queue.

FNXC:VerificationConcurrency 2026-07-15-09:05:
Greptile P1 multi-project: multiple ProjectEngine instances must not last-write the singleton limit. Register each project's desired cap; the effective process limit is the MIN of registered caps (most restrictive wins) so a project set to 1 cannot be overridden by a peer set to 8.
*/
import { AgentSemaphore, PRIORITY_EXECUTE } from "./concurrency.js";

/** Hard ceiling matching the Scheduling UI max. */
export const MAX_CONCURRENT_VERIFICATIONS_HARD_CAP = 8;
/** Floor — at least one verification can always run. */
export const MIN_CONCURRENT_VERIFICATIONS = 1;

/** projectId -> clamped desired limit for that engine instance */
const projectLimits = new Map<string, number>();
let fallbackLimit = MIN_CONCURRENT_VERIFICATIONS;
const verificationSemaphore = new AgentSemaphore(() => resolveEffectiveLimit());

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

function resolveEffectiveLimit(): number {
  if (projectLimits.size === 0) return fallbackLimit;
  let min = MAX_CONCURRENT_VERIFICATIONS_HARD_CAP;
  for (const value of projectLimits.values()) {
    if (value < min) min = value;
  }
  return min;
}

/**
 * Register or update one project's desired verification concurrency.
 * Effective process limit = min(registered project caps).
 */
export function registerProjectVerificationLimit(projectId: string, next: number): void {
  if (!projectId) return;
  projectLimits.set(projectId, clampMaxConcurrentVerifications(next));
}

/**
 * Drop a project's registration when its engine stops so stale caps do not pin the min forever.
 */
export function unregisterProjectVerificationLimit(projectId: string): void {
  if (!projectId) return;
  projectLimits.delete(projectId);
}

/**
 * Legacy setter used by tests and single-engine paths without a project id.
 * Sets the fallback limit when no projects are registered; when projects are
 * registered this is ignored for the effective min (use registerProjectVerificationLimit).
 */
export function setMaxConcurrentVerifications(next: number): void {
  fallbackLimit = clampMaxConcurrentVerifications(next);
}

/** Current effective verification concurrency limit (after clamping / min aggregation). */
export function getMaxConcurrentVerifications(): number {
  return verificationSemaphore.limit;
}

/** Test helper: clear project registrations. */
export function resetVerificationLimitRegistryForTests(): void {
  projectLimits.clear();
  fallbackLimit = MIN_CONCURRENT_VERIFICATIONS;
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
