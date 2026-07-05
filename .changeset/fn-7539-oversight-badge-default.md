---
"@runfusion/fusion": patch
---

summary: Task cards no longer show the "Auto-recovery" oversight badge unless oversight is explicitly configured.
category: fix
dev: `TaskCard.tsx`'s `showOversightBadge` gate now also suppresses the badge when the effective level equals `DEFAULT_PLANNER_OVERSIGHT_LEVEL` ("autonomous") and there is no explicit per-task `plannerOversightLevel` override; an explicit per-task override of "autonomous" still renders the badge.
