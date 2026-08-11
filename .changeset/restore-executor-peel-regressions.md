---
"@runfusion/fusion": patch
---

summary: Restore completion-recommendation capture and the worktree base-refresh guard dropped by a refactor.
category: fix
dev: PR #3317 (U4 executor peel) rewrote executor.ts from a pre-change base, silently deleting two landed fixes. FN-8850's `getCompletionRecommendationGuidance` and its call site are restored in `executor/system-prompt.ts` (the `fn_task_done` validator survived, so recommendations were validated but never requested). The `WorktreeBaseRefreshError` guard is restored in `executor/run-implementation.ts` so a pre-session checkout refusal is left queued instead of terminally parking the task. New `executor-prompt-completion-recommendations.test.ts` pins the prompt wiring that had no coverage.
