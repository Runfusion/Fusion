---
"@runfusion/fusion": patch
---

summary: Backlog-pressure alerts no longer go silent when candidates depend on archived tasks.
category: fix
dev: `isRunnableCandidate` takes the caller's resolved TERMINAL set instead of comparing each dependency to the `done` id.
