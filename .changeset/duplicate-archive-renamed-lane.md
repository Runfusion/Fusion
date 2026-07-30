---
"@runfusion/fusion": patch
---

summary: Duplicate archiving and CLI merge completion work on boards with renamed columns.
category: fix
dev: Also `cli/commands/task-lifecycle`, whose two merge-completion paths passed a hardcoded `"done"`. `duplicate-intake` and `duplicate-guard` passed a hardcoded `"archived"` to `moveTask`. Since the workflow-column rejection went live, a board without that column rejects the move, so the duplicate stays on the board — already stamped `deterministicDuplicateOf`. Both now resolve the `archived`-trait column from the task's workflow, falling back to the legacy id.
