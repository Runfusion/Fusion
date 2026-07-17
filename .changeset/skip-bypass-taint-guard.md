---
"@runfusion/fusion": patch
---

summary: Block tasks that skip unreviewed steps after a completion refusal from auto-promoting to review.
category: fix
dev: New persisted task field `bulkCompletionRefusalAt` is stamped when the executor's `bulk-step-completion-without-review` refusal fires; the pure `evaluateSkipBypassTaint` (in @fusion/core) makes skipped-after-refusal steps not count toward any AUTO-promotion path (executor implicit-completion/finalize, `recoverCompletedTask`, self-healing stuck-in-progress + stranded-todo recovery, graph merge-boundary proof). Cleared on an accepted fn_task_done or operator manual retry; the PREMISE STALE accepted-done flow is unaffected (FN-8141).
