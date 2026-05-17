---
"@runfusion/fusion": patch
---

Fixes a runtime crash where `fn_task_list` and `fn_task_show` could throw in heartbeat/no-task contexts when `getProjectRootFromWorktree` drifted at runtime, by adding a safe fallback project-root resolver path in the CLI extension.
