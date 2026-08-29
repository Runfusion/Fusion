---
title: "Repo-root task worktree causes executor requeue loop"
date: 2026-06-21
category: docs/solutions/logic-errors
module: "engine worktree acquisition + executor liveness"
problem_type: logic_error
component: engine
symptoms:
  - "A resumed task is repeatedly requeued to todo with realpath_matches_repo_root"
  - "git worktree list includes the project root, so worktree classification treats the main checkout as usable"
  - "Acquisition returns the repo root again after recovery, and the executor gate rejects it again"
root_cause: invariant_gap
resolution_type: code_fix
severity: high
related_components:
  - "packages/engine/src/worktree-pool.ts (classifyTaskWorktree)"
  - "packages/engine/src/worktree-acquisition.ts (resume fallback + return guard)"
  - "packages/engine/src/executor.ts (pre-session liveness gate)"
tags:
  - worktrees
  - executor
  - self-healing
  - liveness
  - requeue-loop
---

# Repo-root task worktree causes executor requeue loop

## Problem

A recovered task can carry `task.worktree` that canonicalizes to the project repository root. The root is a valid Git worktree and appears in `git worktree list`, but it is the main checkout, not an isolated task checkout. Before FN-6861, `classifyTaskWorktree(rootDir, rootDir)` returned usable, so resume acquisition returned the root unchanged. The executor then rejected the same path via `realpath_matches_repo_root` and requeued the task, setting up an acquisition → gate → requeue loop.

## Solution

Make the invariant explicit at the shared classification boundary: the project root is never a usable task worktree. `classifyTaskWorktree` now compares canonicalized paths and returns `classification: "repo-root"` for root-equal paths even when Git reports the path as registered.

Because `acquireTaskWorktree` already treats non-usable resume classifications as self-healable stale metadata, a root-valued `task.worktree` is cleared and replaced with a fresh checkout under the configured worktrees directory. FN-6922 adds the same invariant as an acquisition return postcondition: every existing, pooled, and fresh-created return path is checked immediately before returning to executor/heartbeat callers. If a return candidate canonicalizes to the project root, acquisition emits `worktree:incomplete-detected` with `source: "acquire-return-guard"`, clears worktree metadata, and attempts one fresh checkout; if the fresh checkout is also root-equal, it throws `RepoRootWorktreeError` instead of returning the root.

The executor liveness gate remains defense-in-depth and emits structured `worktree:incomplete-detected` evidence if a repo-root path still reaches it.

## Verification

Cover the invariant at three seams:

- Classification: real Git repo root registered in `git worktree list` must classify as `repo-root`, including canonical-equal variants such as trailing slashes or symlink-normalized paths.
- Acquisition: resume with `task.worktree === rootDir` must return a fresh `.worktrees/*` (or configured worktrees-dir) checkout and must not return the root.
- Acquisition return guard: even if a classifier mock/regression marks a root path usable, or if a custom fresh backend returns the root, `acquireTaskWorktree` must either self-heal to a non-root checkout or throw `RepoRootWorktreeError`.
- Executor diagnostics: if the root reaches the pre-session liveness gate, the audit payload must identify `classification: "repo-root"`, the observed path, the registered snapshot, and that the expected task-worktree pattern excludes the root.

## Prevention

Registered Git worktree membership is necessary but not sufficient for task execution. Any new worktree-liveness or self-healing path should call the shared classifier and preserve the distinction between the main checkout (`repo-root`) and isolated task checkouts under the configured worktrees directory. Any new `acquireTaskWorktree` return branch must also flow through the return guard so branch-local checks cannot be the only line of defense.
