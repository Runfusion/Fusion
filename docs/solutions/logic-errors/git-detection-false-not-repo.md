---
title: "Git probe failures falsely reported as not a repository"
date: 2026-07-10
category: docs/solutions/logic-errors
module: "engine Git detection + task executor preflight"
problem_type: logic_error
component: engine
symptoms:
  - "Every task fails immediately with Project directory is not a Git repository"
  - "The project is a valid Git repo, but git rev-parse fails for an environmental reason"
  - "Restarting the engine does not clear the failure because the environment condition persists"
root_cause: error_classification_collapse
resolution_type: code_fix
severity: high
related_components:
  - "packages/engine/src/worktree-pool.ts (detectGitRepository)"
  - "packages/engine/src/executor.ts (dispatch preflight guard)"
  - "packages/engine/src/runtimes/in-process-runtime.ts (startup warning)"
tags:
  - git
  - worktrees
  - executor
  - dubious-ownership
  - false-negative
---

# Git probe failures falsely reported as not a repository

## Problem

A boolean Git repository probe collapses every `git rev-parse --git-dir` failure into `false`. That makes a positive non-repo response indistinguishable from environmental failures such as `fatal: detected dubious ownership`, `spawn ENOENT`, or a hung Git command. The executor then tells operators to run `git init` even when the checkout is already a valid repository, blocking all task execution until the underlying Git environment is fixed.

## Solution

Use tri-state Git detection: `repo`, `not-repo`, or `error`. Only the `not-repo` state may produce the existing "Project directory is not a Git repository" / `git init` guidance. Environmental failures surface the original Git error instead; dubious ownership also includes the explicit safe-directory command:

```bash
git config --global --add safe.directory "<project-root>"
```

The probe remains async and bounded with a timeout, so a hung Git process cannot silently become a false non-repo verdict.

## Verification

Cover the invariant at every consumer of repository detection:

- Detection helper: genuine repo → `repo`; genuine `fatal: not a git repository` → `not-repo`; dubious ownership, missing Git, and timeout → `error`.
- Executor guard: `not-repo` preserves the legacy log/error strings; `error` logs and throws a distinct message without `git init` guidance and does not attempt `git worktree add`.
- Runtime startup: `not-repo` preserves the startup warning; `error` warns with the real Git failure and any safe-directory remedy.
- Worktree-add conflict parsing: `detected dubious ownership` stays `unknown`, not `not-git-repo`, so it does not become a non-retryable `git init` error.

## Prevention

Do not use boolean wrappers at guardrails that need operator-facing diagnosis. Keep positive semantic states separate from probe failures, preserve stderr in the result, and add tests for both a POSIX path and a Windows path with spaces passed through `cwd` rather than interpolated into the shell command.
