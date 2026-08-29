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
 *        update-ref refused without moving it. Under `runAiMerge`, the next
 *        attempt builds a fresh clean-room worktree at the current integration
 *        tip, so the retry succeeds. The safety-fallback auto-prerebase
 *        (`merger-auto-prerebase.ts`, FN-5627) describes only the legacy,
 *        soft-deprecated aiMergeTask pipeline.
 *
 * FNXC:MergerUnification 2026-08-09-12:04: Production retries rebuild the
 * clean room; legacy prerebase is retained but not a live retry mechanism.
 *
 *  - `process-spawn-failure`: Node/OS process launch failed while the merger
 *    was operating from an integration cwd (`spawn ENOTDIR`, `spawn git ENOENT`,
 *    `spawn ENOENT`) or git reported that the AI-merge clean-room path `is not
 *    a working tree`. These indicate the command could not even start because
 *    the cwd/entrypoint/worktree was missing or file-shadowed (for example a
 *    stale temp merge checkout), not that the task branch's code failed. A
 *    fresh merge attempt gets a fresh/revalidated worktree, so the self-healing
 *    sweep can recover these within its bounded retry budget.
 *
 *  - `ai-provider-turn-failure`: the AI merge's LLM turn failed provider-side
 *    (FN-8004). The merger drives a real model to resolve/compose the squash;
 *    when that provider returns an internal/server error, the *merge* failed but
 *    the task branch is untouched and a fresh attempt typically succeeds. Before
 *    FN-8004 no provider fault was modeled here at all, so every one of them was
 *    treated as a permanent defect.
 *
 *  - `network-transport-failure`: delegated to `isTransientError` (see below).
 */
// Imports the import-free leaf, NOT `transient-error-detector.js` — that module pulls
// `usage-limit-detector.js → logger.js`, the exact chain FN-5627 split this file out to avoid.
import type { Task } from "@fusion/core";
import { isTransientError } from "./transient-error-patterns.js";

/** Shared persisted retry budget for automatic transient merge recovery. */
export const MAX_AUTO_MERGE_TRANSIENT_RETRIES = 5;

/*
FNXC:MergeReliability 2026-07-15-18:30:
This classifier used to recognize only git/lease/spawn faults, while the inline retry gate in
`project-engine.ts#maybeRetryTransientMerge` accepted `isTransientError(msg) || classify(msg)`.
The self-healing sweep (`recoverTransientMergeFailures`) consulted ONLY this classifier — so any
network-class error (ECONNRESET, socket hang up, WebSocket drop) got inline retries but became
invisible to the sweep once parked `failed`, stranding it forever.

Delegating to `isTransientError` here makes the two gates agree by construction. Both consumers
now see one definition of "transient", which is what the FN-5627 header above already claimed.
*/
export function classifyTransientMergeError(error: string | null | undefined): string | null {
  if (!error) return null;
  if (/lease-handoff-failed[^a-z]+target-not-queued/i.test(error)) {
    return "lease-handoff-target-not-queued";
  }
  // FNXC:MergeReliability 2026-07-15-18:30 (FN-8004): AI-merge provider faults precede the
  // generic network check so the more specific class wins in the audit/log trail.
  if (/\bACP turn failed\b/i.test(error) || /\bacp rpc code -32(?:603|00[0-3])\b/i.test(error)) {
    return "ai-provider-turn-failure";
  }
  if (/\bspawn(?:\s+\S+)?\s+ENO(?:TDIR|ENT)\b/i.test(error)) {
    return "process-spawn-failure";
  }
  if (/\bis not a working tree\b/i.test(error)) {
    return "process-spawn-failure";
  }
  const sameSha = error.match(/advanced concurrently \(expected ([0-9a-f]{7,40}),\s+observed ([0-9a-f]{7,40})\)/i);
  if (sameSha && sameSha[1].toLowerCase() === sameSha[2].toLowerCase()) {
    return "spurious-concurrent-advance-same-sha";
  }
  // FNXC:MergeReliability 2026-07-15-18:30 (FN-8004): last — the specific git/merge classes above
  // must win the label. This aligns the sweep with the inline retry gate (see header).
  if (isTransientError(error)) {
    return "network-transport-failure";
  }
  return null;
}

/*
FNXC:TaskWedgeNotifications 2026-08-05-04:53:
A transient-error string is diagnostic evidence, not notification ownership by
itself. Fusion suppresses terminal alerts only after the merge writer persists
an in-budget retry marker; the same shared cap makes exhaustion operator-actionable.
*/
export function hasTransientMergeRecoveryOwner(task: Pick<Task, "error" | "mergeTransientRetryCount">): boolean {
  return classifyTransientMergeError(task.error) !== null
    && typeof task.mergeTransientRetryCount === "number"
    && Number.isInteger(task.mergeTransientRetryCount)
    && task.mergeTransientRetryCount >= 0
    && task.mergeTransientRetryCount < MAX_AUTO_MERGE_TRANSIENT_RETRIES;
}
