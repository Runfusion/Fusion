---
category: reliability
module: "@fusion/engine"
tags: [merge, cancellation, task-store, git]
problem_type: race-condition
applies_when: "A merge generation can outlive cancellation while a successor owns the same task."
---

# Fence orphan merge-body writes

An abort signal is write authority for a claimed merge generation. An aborted signal means that body no longer owns the task row; the successor owns a fresh signal. Ownership must be read immediately before each mutation or irreversible action. A function-entry, closure, loop-head, or shared adjacent-writer check is unsound because an abort may arrive during the preceding await.

`merge-write-fence.ts` supplies one fence per merge body. Diagnostic and rebound writes use `fence.write`, which silently suppresses an orphaned call. Finalization, task completion, commit association, branch-group updates, group-PR synchronization, and cleanup use `assertOwned`, which throws `MergeAbortedError` so the body unwinds instead of leaving a partially finalized successor row. Every catch on the merge path rethrows that error; it is never classified as a transient failure, partial workspace land, rebound result, or group-PR sync failure.

## Boundary policy mapping

Each entry is a single action at its own boundary:

| Boundary/action | Bucket | Guard |
| --- | --- | --- |
| `runAiMerge` log entry | suppress | `fence.write("log")` |
| `runAiMerge` agent log append | suppress | `fence.write("log")` |
| `landWorkspaceTask` log entry | suppress | `fence.write("log")` |
| `landWorkspaceTask` agent log append | suppress | `fence.write("log")` |
| transient merge status update | suppress | `fence.write("lifecycle")` |
| single-repo no-commits rebound error update | suppress | `fence.write("lifecycle")` |
| single-repo no-commits rebound diagnostic | suppress | `fence.write("log")` |
| single-repo no-commits rebound move | suppress | `fence.write("lifecycle")` |
| single-repo missing-proof rebound error update | suppress | `fence.write("lifecycle")` |
| single-repo missing-proof rebound diagnostic | suppress | `fence.write("log")` |
| single-repo missing-proof rebound move | suppress | `fence.write("lifecycle")` |
| single-repo overseer-veto rebound error update | suppress | `fence.write("lifecycle")` |
| single-repo overseer-veto rebound diagnostic | suppress | `fence.write("log")` |
| single-repo overseer-veto rebound move | suppress | `fence.write("lifecycle")` |
| workspace missing-proof rebound error update | suppress | `fence.write("lifecycle")` |
| workspace missing-proof rebound diagnostic | suppress | `fence.write("log")` |
| workspace missing-proof rebound move | suppress | `fence.write("lifecycle")` |
| auto-finalization hard-blocker update | throw | `fence.assertOwned()` |
| workspace final `mergeDetails` update | throw | `fence.assertOwned()` |
| workspace finalization hand-off | throw | `fence.assertOwned()` |
| final merge-details/files update | throw | `fence.assertOwned()` |
| commit association | throw | `fence.assertOwned()` |
| cleanup merge-details update | throw | `fence.assertOwned()` |
| branch deletion | throw | `fence.assertOwned()` |
| worktree removal | throw | `fence.assertOwned()` |
| worktree-clear update | throw | `fence.assertOwned()` |
| branch-group member landing | throw | `fence.assertOwned()` |
| managed group-PR sync | throw | `fence.assertOwned()` |
| auto-finalization task update | throw | `fence.assertOwned()` |
| auto-finalization column move | throw | `fence.assertOwned()` |
| auto-finalization tail log | throw | `fence.assertOwned()` |
| `task:merged` emit | throw | `fence.assertOwned()` |
| squash case-B CAS ref advance | throw | `assertMergeGenerationOwned()` |
| squash dirty-checkout CAS ref advance | throw | `assertMergeGenerationOwned()` |
| squash case-A fast-forward merge | throw | `assertMergeGenerationOwned()` |
| push-after-merge ref advance | throw | `assertMergeGenerationOwned()` |
| `persistRepoLandedSha` | deliberately unfenced | Records an already-completed advance; suppressing it can recreate double-squash landing. |
| append-only run audit | deliberately unfenced | Forensic data does not mutate task ownership; aborts are excluded from sync-failure classification. |

The squash helper receives an optional signal. Existing direct callers without a signal retain prior behavior. Its loop-head cancellation checks remain cheap early-outs, but each actual ref advance has its own immediate ownership check.

A non-abort failure in an already-orphaned rebound may have its next rebound write suppressed; no compensating mutation is made because the successor owns the row. Similarly, an abort at branch/worktree cleanup may leave cleanup for the successor or existing self-healing. Completion announcement remains last, preventing an abandoned body from announcing a merge.

## Observability

The fence gets an injected `recordRunAuditEvent` recorder; no ambient or module-global state is used. It emits one `merge:orphan-write-fenced` event on the fence's first interaction with `{ taskId, category, interaction, suppressedCount }`. The emit-time count is `1` for a suppression-first interaction and `0` for a rejection-first interaction. Later suppressions only increase the in-process counter: no end-of-body cumulative event is attempted because unwinding cannot reliably flush one. The rejection-first case is therefore unit-tested at the fence level.

This completes the progression from FN-8912's transient-status fence and FN-8923's call-site inventory. The regression suite drives real single-repository and workspace bodies so an orphan rejects with `MergeAbortedError` while successor-owned task state remains independent.
