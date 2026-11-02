---
title: In-review files-changed inflated by origin-first baseCommitSha capture
date: 2026-06-03
category: logic-errors
module: engine
problem_type: logic_error
component: development_workflow
symptoms:
  - "In-review tasks showed 20-31 files changed when only 2-12 were actually touched"
  - "Extra files in a task's diff belonged to other, already-merged tasks"
  - "All in-review tasks in a cohort shared a suspiciously old baseCommitSha"
  - "Inflation was permanent — display-time merge-base recovery could not tighten it"
  - "A mandatory code-review gate refused every attempt with `review-input-unprovable (git-diff-too-large)` and never dispatched a reviewer"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags:
  - git-merge-base
  - basecommitsha
  - fork-point
  - origin-vs-local-main
  - files-changed
  - worktree-pool
  - rebase-and-push
  - diff-base
  - review-input-proof
  - streamed-hash
  - descendant-merge-base
---

# In-review files-changed inflated by origin-first baseCommitSha capture

## Problem

New task branches recorded a `baseCommitSha` that was too old, so the dashboard's `baseCommitSha..HEAD` diff swept in files belonging to other, already-merged tasks — showing 20–31 "files changed" when the task actually touched 2–12 (FN-5937: 31 shown vs 12 real). `captureBaseCommitSha` computed `git merge-base HEAD origin/main` while the merger lands commits on **local** main before pushing.

## Symptoms

- In-review tasks on the dashboard displayed inflated "files changed" counts (20–31) versus their true touched-file count (2–12).
- The extra files all belonged to other tasks that had already merged (FN-5937's inflated diff contained files from FN-5936/FN-5907/FN-5939/FN-5940).
- The inflation was **permanent** — display-time recovery could not tighten it because the orphaned predecessor SHAs were no longer reachable from `main`.
- All in-review tasks in a dispatch cohort shared a suspiciously too-old `baseCommitSha`; the pattern recurred on the next cohort (FN-5953) after the next rebase-push cycle.

## What Didn't Work

- **Worktree-pool reassignment** — a recycled worktree hosting a foreign branch could surface another task's commits. Ruled out: the diff routes guard this via `worktreeStillBelongsToTask`, and each worktree's HEAD matched its task's recorded branch.
- **Stale-base display recovery** — the dashboard already re-tightens stale bases at display time via `merge-base(HEAD, main)` (FN-2957/FN-2840). Ruled out: recovery is structurally unable to help here because the orphaned predecessor SHAs no longer exist in `main`, so the merge-base lands on the same too-old commit as the stored base.
- **Branch-group sharing** — tasks sharing a branch group legitimately share commits. Ruled out: the contaminating commits came from unrelated, independently-merged tasks, and the captured base predated the true fork point regardless of grouping.

> **Superseded in part on 2026-11-02 (RUFU-445).** The local-first `||` chain below is still correct
> for the contamination-base sites, but as a *general* rule it was incomplete: it fixes the
> local-ahead case and silently mishandles the remote-ahead case. Both selection sites now share one
> descendant rule and `resolveDiffBaseRef` — the last origin-first outlier — is covered too. Read
> **"The rule is now: pick the descendant merge-base"** below before copying the command line.

## Solution

Extract the capture into `packages/engine/src/base-commit-capture.ts` (`resolveCapturedBaseCommitSha`) and swap the merge-base command to **local-first**:

```sh
# before (executor.ts captureBaseCommitSha) — origin-first
git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main

# after (base-commit-capture.ts) — local-first
git merge-base HEAD main 2>/dev/null || git merge-base HEAD origin/main
```

This matches the two sibling contamination-base sites that were **already** local-first (`worktree-acquisition.ts`, `auto-recovery-handlers/branch-worktree.ts`); the capture site was the only origin-first outlier. A real-git regression suite (`packages/engine/src/__tests__/base-commit-capture.real-git.test.ts`) locks the behavior in, including the local-ahead-of-origin scenario. The 5 already-corrupted live in-review tasks were repaired in place via `TaskStore.updateTask`, recomputing each base as the parent of the branch's first own-attributed commit, with ancestry safety checks. Shipped in PR Runfusion/Fusion#1376.

## Why This Works

The merger integrates tasks by landing their commits on **local** `main` first, then later rebase-and-pushes. Two consequences flow from this:

1. At the moment a new task's base is captured (right after worktree acquisition — the worktree forks from the **local** main tip via `prepareForTask` → `resolveIntegrationBranch`), local `main` can be **ahead of `origin/main`** by merged-but-unpushed commits. Measuring `merge-base HEAD origin/main` rewinds the base past those commits.
2. The post-merge rebase-and-push rewrites those commits' SHAs in `main`, **orphaning** the originals that the task branch still descends from. Even display-time `merge-base(HEAD, main)` recovery can't find a tightening point afterward — the orphaned SHAs aren't in `main` anymore.

```
fork time:   ...59cd9ea ── 839d191 (merged, unpushed) ── 8db04c4  ← local main tip
                                                            │
                                                            └─ taskBranch: a1 a2 ...
captured base = merge-base(HEAD, origin/main) = 59cd9ea   ← too old: includes 839d191's files

after rebase-push:  main = ...59cd9ea ── <PR merges> ── 419f688 (was 839d191) ── ...
                    taskBranch still descends from the now-orphaned 839d191/8db04c4
                    merge-base(HEAD, main) = 59cd9ea → no recovery possible
diff 59cd9ea..HEAD  permanently shows predecessors' files as this task's changes
```

**The invariant:** any base / fork-point computation in this codebase must measure against **local `main` first**, with `origin/main` only as a fallback. Because the merger lands commits locally before pushing — and the push rewrites their SHAs — `origin/main` is systematically behind, and an origin-first merge-base will rewind the base into a predecessor's history and then strand it.

## The rule is now: pick the descendant merge-base (RUFU-445, 2026-11-02)

The same class reappeared two years later with a worse failure mode. RUFU-281 sat in `in-review` for a week while its mandatory `code-review` gate never dispatched: every attempt refused with `review-input-unprovable`, and the durable row said only `Reason: (no feedback captured)`. Measured cause — `resolveDiffBaseRef` was still origin-first (`merge-base HEAD origin/main || merge-base HEAD main`), the card had no stored `baseCommitSha`, and its worktree's local `main` was 709 commits ahead of `origin/main`. The chosen base sat 628 commits behind the card's own fork point, so the reviewer's "input" was 628 commits of unpublished `main` history — **38 867 308 bytes** of `git diff --binary` against the card's real 112 781 bytes — which overflowed the 10 MiB capture bound and refused forever. A *display* inflation of this size is an annoyance; the same number on the review-input proof is a permanent merge wedge.

Two invariants had to be restored together, because either one alone leaves the wedge in place:

1. **A base is the integration fork point, never "whichever ref is older."** Local-first is right when local is ahead and wrong after a rebase onto the remote-tracking ref (RUFU-217). The rule that survives both is: measure `merge-base HEAD 'main'` **and** `merge-base HEAD 'origin/main'`, then take whichever is the strict descendant of the other (`git merge-base --is-ancestor`). That decision now lives in ONE exported seam — `resolveDescendantMergeBase` in `packages/engine/src/execution/base-commit-capture.ts` — consumed by both `resolveCapturedBaseCommitSha` (terminal fallback `git rev-parse HEAD`) and `resolveDiffBaseRef` (terminal fallback `git rev-parse HEAD~1`). Each caller keeps its OWN fallback: they are different contracts and must not be merged.
2. **Review-input proof must stream.** `probeReviewDiffFingerprint` piped `git diff --binary` into an `execFile.maxBuffer` that had to hold the whole patch. It now pipes stdout into `createHash("sha256")` chunk-by-chunk and enforces the same `REVIEW_DIFF_GIT_MAX_BUFFER_BYTES` as a *streamed byte ceiling*, killing the child the moment it is crossed. Memory is chunk-bounded; the refused size is unchanged; nothing is truncated silently. The empty-vs-unreadable split is preserved verbatim (zero bytes + clean exit → empty → `EMPTY_REVIEW_DIFF_FINGERPRINT`; spawn error / timeout kill / non-zero exit → `git-diff-failed`).

One honest residual of (2): the legacy digest hashed the utf8-**decoded** stdout string, the streamed one hashes raw bytes. They are identical for any patch that round-trips through utf8 (git's own base85 `GIT binary patch` blocks are ASCII, so they do) — pinned by `review-diff-fingerprint-buffer.test.ts`. For a byte-lossy patch (a text file holding invalid utf8) the digest MAY differ, which costs at most one "review input changed" convergence round; it can never approve an unreviewed change or wedge a merge, because an input fingerprint is only ever compared against another input fingerprint.

And the refusal must be *readable*: a `review-input-unprovable` refusal now publishes `node:<id>:error` on the node result, which is the key `synthesizeNonVerdictFailureOutput` reads to fill a failed non-verdict gate's `output`. Without it the durable row degrades to `(no feedback captured)` and an operator cannot tell an unfixable stale-base overflow from a transient git failure.

## Prevention

- **Follow the invariant**: a base/fork-point *selection* goes through `resolveDescendantMergeBase` (or a caller of it — `resolveCapturedBaseCommitSha`, `resolveDiffBaseRef`). Never lead with `origin/main`, and do not hand-roll a local-first `||` chain for a new base site: local-first alone regresses the post-rebase shape.
- **Grep check for regressions** — any origin-first site is suspect:

  ```sh
  grep -rn "merge-base HEAD origin/" packages/engine/src
  ```

  `origin/main` may only ever appear as the fallback tail after a `||`. The three remaining production hits are contamination-base sites (`executor/worktree-git-refs.ts`'s `resolveContaminationBaseRef`, `worktree/worktree-acquisition.ts`, `auto-recovery-handlers/branch-worktree.ts`) plus comments — a contamination base asks "what did this branch inherit", which the older of the two merge-bases answers correctly, so those chains stay local-first on purpose.
- **Real-git test pattern for local-ahead-of-origin**: build a real repo where local `main` is advanced past `origin/main` (commit locally without pushing), fork a task branch from the local tip, and assert the captured base equals the **local fork point**, not the origin merge-base. String-matched command mocks cannot distinguish ordering inside a shell `||` — this scenario must run against actual git (see `base-commit-capture.real-git.test.ts` and `worktree-diff-base-ordering.real-git.test.ts`, which also mirrors the remote-ahead/rewound-local case).
- **Measure the control in an over-budget test.** The real-git proof case does not assert that a big diff is "big enough" — it runs `git diff --binary` and asserts the origin-first base's patch really exceeds `REVIEW_DIFF_GIT_MAX_BUFFER_BYTES` while the integration base's patch stays under 64 KiB. A premise asserted as a number is a premise that can rot silently.

## Related Issues

- RUFU-445 — `resolveDiffBaseRef` joins the descendant rule, the review-input proof streams, and the refusal reason reaches the durable step row; RUFU-281 was the wedged card this documents
- RUFU-217 / RUFU-231 — the remote-ahead (post-rebase) half of the descendant rule, first written at the capture site
- PR Runfusion/Fusion#1376 — the fix this doc documents
- Runfusion/Fusion#256 (FN-4425) — introduced the files-changed surface for in-review tasks; lineage of the capture path
- Runfusion/Fusion#424 (FN-4741) — rebase-merge diff truncation for done tasks; same diff-range-after-rebase failure family
- Runfusion/Fusion#304 / Runfusion/Fusion#349 (FN-4576/FN-4647) — earlier done-task diff-mismatch fixes in the same symptom family
- [per-task-auto-merge-override-ignored-by-trigger-gates](./per-task-auto-merge-override-ignored-by-trigger-gates.md) — adjacent in-review lifecycle bug (task silently presents wrong state in review)
