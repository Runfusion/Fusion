---
"@runfusion/fusion": patch
---

summary: Stale-dependency cleanup no longer releases a task to edit files another agent still holds, on renamed boards.
category: fix
dev: The two `shouldHoldActiveFileScopeLease` call sites in self-healing now pass resolved `isWipColumn`/`isReviewColumn` from the wip/review sets those sweeps already resolve, matching the scheduler's own call sites.
