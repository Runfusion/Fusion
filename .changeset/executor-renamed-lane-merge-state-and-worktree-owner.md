---
"@runfusion/fusion": patch
---

summary: Fix stale merge state and a duplicate worktree hand-off on boards with renamed columns.
category: fix
dev: Two executor guards compared lifecycle column ids literally. `resetMergeStateIfNeeded` clears merge state when a card leaves a lane where a merge could have been recorded (the review and complete roles); on a renamed board neither comparison matched, so a card re-entering execution carried stale `mergeDetails` from its previous pass. The worktree-owner scan asks "who else is actively working here?" — the WIP role — and matched nobody on a renamed board, so the worktree read as unowned and a second task could be handed a checkout already in use. Both now resolve from the task's own workflow.
