---
"@runfusion/fusion": patch
---

summary: Recovery and oversight now wait for approval-blocked tasks instead of resuming them early.
category: fix
dev: Adds canonical `awaiting-approval` pause reason + `isTaskBlockedOnApproval` predicate; excludes the hold from paused-scope-decay rebound and keeps the planner overseer withholding (FN-7736).
