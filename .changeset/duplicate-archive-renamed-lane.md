---
"@runfusion/fusion": patch
---

summary: Duplicate archiving, CLI merge completion, and stuck-task recovery work on boards with renamed columns.
category: fix
dev: Also `cli/commands/task-lifecycle`, whose two merge-completion paths passed a hardcoded `"done"`. `duplicate-intake` and `duplicate-guard` passed a hardcoded `"archived"` to `moveTask`. Since the workflow-column rejection went live, a board without that column rejects the move, so the duplicate stays on the board — already stamped `deterministicDuplicateOf`. Both now resolve the `archived`-trait column from the task's workflow, falling back to the legacy id. Four auto-recovery requeues (contamination, foreign-only contamination x2, and the restart path) passed a hardcoded `"todo"` to `moveTask` for the same reason; on a board without that column the move was rejected and the recovery never completed, leaving the task stuck in exactly the state the recovery exists to clear. All four now resolve the rebound target from the task's own workflow.
