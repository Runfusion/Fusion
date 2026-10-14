/**
 * Shared budget for the PostgreSQL health/integrity probe, so the transport and
 * the probe caller can never disagree about when a health statement must die.
 *
 * FNXC:PostgresHealthTransport 2026-09-26-00:40 (RUFU-301):
 * The health session is `max: 1`, so one abandoned probe read serializes every
 * later readiness read behind it. Measured on a 60k-task corpus the probe itself
 * costs 21.6 ms scoped (68.4 ms unscoped), so the 5 s budget is not a capacity
 * limit; the failures were lock-queued reads that the client gave up on while
 * PostgreSQL kept executing them. The session therefore carries a server-side
 * `statement_timeout` strictly below the probe budget: the database cancels its
 * own work at the deadline instead of leaving it on the shared session. The
 * margin keeps the server-side cancellation (which arrives as an error the
 * caller can classify) ahead of the client deadline.
 */

/** Default total budget for one dashboard PostgreSQL health probe. */
export const DEFAULT_HEALTH_PROBE_BUDGET_MS = 5_000;

/** How far below the probe budget the health session cancels its own statements. */
export const HEALTH_SESSION_STATEMENT_SAFETY_MARGIN_MS = 250;

/**
 * Server-side statement cap for the dedicated health session.
 *
 * The cap must be strictly below the caller's budget whenever that budget leaves
 * room for the safety margin, and it must never be zero or negative in any case:
 * PostgreSQL reads `statement_timeout = 0` as "never cancel", which would restore
 * the exact wedge this cap exists to prevent.
 *
 * @param budgetMs Total probe budget the caller will enforce.
 * @returns A positive timeout, at least one millisecond below that budget.
 */
export function healthSessionStatementTimeoutMs(
  budgetMs: number = DEFAULT_HEALTH_PROBE_BUDGET_MS,
): number {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    return healthSessionStatementTimeoutMs(DEFAULT_HEALTH_PROBE_BUDGET_MS);
  }
  const budget = Math.floor(budgetMs);
  return Math.max(
    1,
    Math.min(budget - HEALTH_SESSION_STATEMENT_SAFETY_MARGIN_MS, budget - 1),
  );
}
