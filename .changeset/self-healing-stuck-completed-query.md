---
"@runfusion/fusion": patch
---

summary: Step-complete tasks stranded by a dead session now reach review on boards with renamed columns.
category: fix
dev: `recoverCompletedTasks` read the literal `in-progress`, so a task whose steps were all done but whose session died before the hand-off to review was never found on a renamed board. The read resolves via `resolveProjectColumnsForRoles` and the per-card column check resolves per card, falling back to the project set when a card's own workflow is unreadable.
