/**
 * FNXC:CodeOrganization 2026-08-03-07:45:
 * Orphan resume delay policy peeled from executor.ts.
 */

/**
 * How long to wait after engine startup before spawning AI agent sessions for
 * orphaned in-progress tasks. The work itself (worktree setup, pi-coding-agent
 * session creation, child process spawn) is heavy and saturates the event
 * loop, which makes the dashboard unresponsive during cold start when there
 * are orphaned tasks from a prior run. Pushing this work past the initial
 * load window keeps the UI snappy; the tasks still resume — just after the
 * user has had time to see the board.
 *
 * Override via FUSION_RESUME_ORPHAN_DELAY_MS. Defaults to 0 under Vitest so
 * existing tests that expect immediate resumption keep passing without
 * needing per-test plumbing.
 *
 * Read lazily so an env-var change between module load and resumeOrphaned()
 * call (e.g. set in a test setup file) is observed.
 */
export function getResumeOrphanDelayMs(): number {
  const raw = process.env.FUSION_RESUME_ORPHAN_DELAY_MS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  if (process.env.VITEST || process.env.NODE_ENV === "test") return 0;
  return 30_000;
}
