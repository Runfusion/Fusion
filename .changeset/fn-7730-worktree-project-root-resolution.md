---
"@runfusion/fusion": patch
---

summary: Board mutations from a tool session no longer silently land in the wrong project database.
category: fix
dev: FN-7730. `packages/core/src/pi-extensions.ts`'s `getProjectRootFromGitLinkedWorktree` now resolves a linked worktree's project root from git's own on-disk `.git`/`commondir` metadata (pure filesystem reads) before falling back to the `git rev-parse` CLI. Previously, for a non-standard `settings.worktreesDir` location combined with a failing `git` invocation (missing binary, Docker "dubious ownership" `safe.directory` refusal, etc.), resolution silently fell through to the task's own locally-hydrated `.fusion/fusion.db` instead of the true project root, so `fn_task_update` and other pi-extension write tools wrote to a throwaway, never-synced-back copy with no error surfaced. See docs/storage.md "Silent board-mutation write loss (FN-7730)" for the full root-cause writeup.
