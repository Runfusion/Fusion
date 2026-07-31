---
"@runfusion/fusion": patch
---

summary: Dead cards no longer hold a work slot forever on boards with renamed columns.
category: fix
dev: `recoverInProgressLimbo` read the literal `in-progress`, so a card holding a wip slot with no worktree, no branch and no started step was never reclaimed on a renamed board. The read resolves via `resolveProjectColumnsForRoles` and the per-card column check resolves per card, falling back to the project set when a card's own workflow is unreadable.
