---
"@runfusion/fusion": patch
---

summary: `fn project` now counts running agents correctly on renamed workflow boards.
category: fix
dev: `runningAgentCount` fed raw task rows to `isRunningAgentTaskShape`, so its internal legacy column fallback applied and any board without the literal `in-progress`/`todo` ids reported 0. The command now resolves each task's workflow IR (cached per workflow) via `enrichRunningAgentTaskShape` before counting.
