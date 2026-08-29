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

## Prevention

- **Follow the invariant**: every base/fork-point computation uses `git merge-base HEAD main 2>/dev/null || git merge-base HEAD origin/main` (local-first). Never lead with `origin/main`.
- **Grep check for regressions** — any origin-first site is suspect:

  ```sh
  grep -rn "merge-base HEAD origin/" packages/engine/src
  ```

  `origin/main` should only ever appear as the fallback tail after a `||`.
- **Real-git test pattern for local-ahead-of-origin**: build a real repo where local `main` is advanced past `origin/main` (commit locally without pushing), fork a task branch from the local tip, and assert the captured base equals the **local fork point**, not the origin merge-base. String-matched command mocks cannot distinguish ordering inside a shell `||` — this scenario must run against actual git (see `base-commit-capture.real-git.test.ts`).

## Related Issues

- PR Runfusion/Fusion#1376 — the fix this doc documents
- Runfusion/Fusion#256 (FN-4425) — introduced the files-changed surface for in-review tasks; lineage of the capture path
- Runfusion/Fusion#424 (FN-4741) — rebase-merge diff truncation for done tasks; same diff-range-after-rebase failure family
- Runfusion/Fusion#304 / Runfusion/Fusion#349 (FN-4576/FN-4647) — earlier done-task diff-mismatch fixes in the same symptom family
- [per-task-auto-merge-override-ignored-by-trigger-gates](./per-task-auto-merge-override-ignored-by-trigger-gates.md) — adjacent in-review lifecycle bug (task silently presents wrong state in review)
