---
"@runfusion/fusion": patch
---

summary: Keep re-locked plans marked as previously diverged instead of resetting to on plan.
category: fix
dev: Engine spec-drift snapshot derives priorDivergence from the retained report history via the shared hasPriorLockDivergence helper.
