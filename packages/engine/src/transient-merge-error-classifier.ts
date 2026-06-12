/**
 * FN-5627: Shared classifier for transient merge failure error messages.
 *
 * Extracted from `self-healing.ts` to break the import chain that would
 * otherwise pull in `createLogger` and break `vi.mock("../logger.js")` setups
 * in tests that don't currently mock the full logger surface (notification-
 * service.test.ts in particular).
 *
 * Used by both `SelfHealingManager.recoverTransientMergeFailures` (the
 * recovery sweep) and `NotificationService.handleTaskUpdated` (the
 * notification-suppression gate). Both consumers must agree on what counts
 * as transient so the user doesn't get ntfy alarms for failures that the
 * engine will auto-recover within bounded budget.
 *
 * Recognized classes:
 *
 *  - `lease-handoff-target-not-queued`: the merge queue lease acquisition saw
 *    the task drop out of the queue between enqueue and handoff. Race with
 *    self-healing sweeps that clean stale `mergeQueue` rows (FN-5353/FN-5363).
 *
 *  - `spurious-concurrent-advance-same-sha`: the merger reported
 *    `Integration branch X advanced concurrently (expected SHA, observed SHA)`
 *    with identical SHA on both sides. This signature shows up in two cases:
 *    (1) Pre-FN-5627 misclassification in `merger-ref-update-advance.ts`
 *        routed real ref-update-refusal failures (lock contention, hook
 *        rejection) through `IntegrationBranchConcurrentAdvanceError`.
 *    (2) Post-FN-5627: the merger's `advanceIntegrationBranchRef` correctly
 *        detects `non-fast-forward-advance` when the freshly built squash
 *        commit does not descend from the current integration ref. The error
 *        carries the same SHA in both the "expected" and "observed" slots
 *        because the pre-advance rev-parse captured the ref state and
 *        update-ref refused without moving it. On the next merge attempt,
 *        the safety-fallback auto-prerebase (`merger-auto-prerebase.ts`,
 *        FN-5627) rebases the task branch onto current main, so the retry
 *        succeeds.
 *
 *  - `process-spawn-failure`: Node/OS process launch failed while the merger
 *    was operating from an integration cwd (`spawn ENOTDIR`, `spawn git ENOENT`,
 *    `spawn ENOENT`). These indicate the command could not even start because
 *    the cwd/entrypoint was missing or file-shadowed (for example a stale temp
 *    merge checkout), not that the task branch's code failed. A fresh merge
 *    attempt gets a fresh/revalidated worktree, so the self-healing sweep can
 *    recover these within its bounded retry budget.
 */
export function classifyTransientMergeError(error: string | null | undefined): string | null {
  if (!error) return null;
  if (/lease-handoff-failed[^a-z]+target-not-queued/i.test(error)) {
    return "lease-handoff-target-not-queued";
  }
  if (/\bspawn(?:\s+\S+)?\s+ENO(?:TDIR|ENT)\b/i.test(error)) {
    return "process-spawn-failure";
  }
  const sameSha = error.match(/advanced concurrently \(expected ([0-9a-f]{7,40}),\s+observed ([0-9a-f]{7,40})\)/i);
  if (sameSha && sameSha[1].toLowerCase() === sameSha[2].toLowerCase()) {
    return "spurious-concurrent-advance-same-sha";
  }
  return null;
}
