---
category: reliability
module: workspace-merge
tags: [workspace, finalization, review]
problem_type: livelock
---

# Workspace empty merge-boundary finalization livelock

## Symptom

A second workspace merge pass could lose its repository set after an earlier land, infer success from the empty set, and repeatedly schedule recovery without finalizing. The visible task could retain completed steps while a historical checkout commit, a failed Code Review, and restart-reset retry counters prevented useful progress.

## Resolution

Merge readiness preserves confirmed-scope repositories with durable `landedSha` evidence as finalization obligations. Unexplained empty sets, duplicate declarations, and duplicate worktree paths fail closed. Direct landing and recovery consult canonical pre-merge blockers, use durable transient retry state, and distinguish technical lease/fence failures from real contention.

Workspace review remediation stores only the scope revision, failing repository, and normalized review input signature. The rerun uses that repository's acquired worktree without persisting a singular/root route. Scope changes clear both approval evidence and this target atomically; an APPROVE for the matching current scope clears the target as it records refreshed evidence. An unchanged repeated `REVISE`, including an empty finding list, parks for operator action instead of dispatching another executor.

## H1–H13 evidence matrix

| Hypothesis | Conclusion | Prevention |
| --- | --- | --- |
| H1 empty second-pass obligations | Confirmed | `resolveWorkspaceMergeReadiness` retains landed scoped repositories and blocks unexplained emptiness. |
| H2 historical same-ID commit attribution | Confirmed | Main-checkout evidence is bounded by base/landing proof and task ownership. |
| H3 operator-only refusal consumes retries | Confirmed | `main_checkout_edit` parks on first refusal without executor retry consumption. |
| H4 failed review ignored by recovery | Confirmed | Landing and recovery use the canonical merge blocker before scheduling or Git mutation. |
| H5 recovery logged as success before result | Confirmed | Recovery logs scheduling separately from proven landing/finalization. |
| H6 restart resets loop budget | Confirmed | `mergeTransientRetryCount` is persisted before transient recovery scheduling. |
| H7 empty-finding REVISE loops | Confirmed | Durable normalized remediation signatures fence repeated unchanged review input. |
| H8 wrong worktree remediation | Confirmed | Remediation selects the failing repository worktree and suppresses singular route persistence. |
| H9 later repositories unreviewed | Confirmed | Current fingerprints require approval evidence for every modified repository. |
| H10 competing completion owners | Contributing signal | Existing graph continuation, merge pending, dispatch fence, and repository lease ownership remain authoritative. |
| H11 out-of-scope formatting | Non-causal safety guard | File Scope evidence remains a merge block and was not weakened. |
| H12 optional deployment callback | Confirmed risk | Direct `landWorkspaceTask` performs its own canonical blocker check. |
| H13 planning dispatch noise | Non-causal signal | Existing PostgreSQL planning-episode deduplication remains unchanged. |

## FN-112 linked-task-worktree regression

FN-106 correctly rejected unexplained empty obligations, but its landing capture compared `HEAD` with `entry.branch` from `entry.worktreePath`. In production that path is the live linked task worktree, where both names normally resolve to the same task tip. The self-comparison made reviewed changes look empty and produced `Workspace merge has no evidenced landing obligations`.

Landing now uses one range for all evidence: the immutable acquisition `baseCommitSha` to the persisted task branch. Legacy entries without that SHA resolve their recorded repository target and derive a merge base against that branch. This matches Code Review's acquisition-base-to-linked-`HEAD` fingerprint while retaining the fail-closed readiness rule for unreadable bases, stale review fingerprints, out-of-scope work, duplicates, net-zero branches, and unexplained emptiness. Real-Git lifecycle coverage keeps a registered linked task worktree alive rather than substituting the main checkout, and proves exactly-once integration advancement, durable per-repository and aggregate landing proof, and terminal finalization.

## Regression coverage

Run the targeted engine workspace merger, self-healing, checkout-guard, review-routing, lease, real-Git slow, PostgreSQL workspace, CLI, and dashboard consumer tests listed in FN-106. The symptom fixture covers a pre-baseline same-ID commit, a previously landed scoped repository, an all-landed second pass, failed Code Review admission, recreated recovery owners, and the live linked-task-worktree shape repaired by FN-112.

## FN-120: review producer and landing consumer must share evidence

A valid merge boundary cannot be tested by constructing the verifier's fingerprint in fixtures. The production review capture must produce the approval consumed by landing, including the clean acquired-peer case. Otherwise attribution-aware review selection and raw branch-range landing can disagree while unit tests remain green.
