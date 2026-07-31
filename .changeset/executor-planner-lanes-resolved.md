---
"@runfusion/fusion": patch
---

summary: Completed work stranded in a renamed planning column is now recovered instead of stuck there.
category: fix
dev: `recoverCompletedTask` resolves the planner lanes and the promotion target from the task's own workflow (`resolvePlannerLanes`, now shared from `replan-target.ts`), and the planning-evacuation branch of the `task:moved` handler uses the same classification via `isPlannerColumnFor`.
