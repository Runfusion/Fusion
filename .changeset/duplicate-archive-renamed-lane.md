---
"@runfusion/fusion": patch
---

summary: Duplicate tasks are archived correctly on boards whose archive column is renamed.
category: fix
dev: `duplicate-intake` and `duplicate-guard` passed a hardcoded `"archived"` to `moveTask`. Since the workflow-column rejection went live, a board without that column rejects the move, so the duplicate stays on the board — already stamped `deterministicDuplicateOf`. Both now resolve the `archived`-trait column from the task's workflow, falling back to the legacy id.
