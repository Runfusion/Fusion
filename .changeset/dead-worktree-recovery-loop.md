---
"@runfusion/fusion": patch
---

summary: A review task whose worktree was removed now gets a fresh one instead of failing on every retry.
category: fix
dev: `autoRecoverWorktreeSessionStartFailure` only preserves `task.worktree` when that path is still a usable checkout (exists + `.git`, via `isUsableWorktreeDirectory`/`hasRequiredWorktreeFiles`). Previously a failing path that merely DIFFERED from `task.worktree` — e.g. an AI-merge clean room refused as an "incomplete worktree" — was read as proof the recorded worktree was live, so a removed worktree was carried into every requeue until the retry budget was exhausted.
