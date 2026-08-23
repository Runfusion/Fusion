---
"@fusion/core": patch
---

summary: Restore executor guidance for assigning workflows to newly created tasks.
category: fix
dev: Executor prompt templates again state that agents may set workflows on tasks they create, matching the guarded prompt contract while preserving the ban on rerouting the task currently being executed.
