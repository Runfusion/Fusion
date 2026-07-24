---
"@runfusion/fusion": patch
---

summary: Fix duplicate planning sessions created when navigating away from and back to Planning.
category: fix
dev: The seeded `planningInitialPlan` handoff is now one-shot — `PlanningModeModal` consumes it via `onInitialPlanConsumed` when auto-start fires, so remounts restore the persisted active session instead of auto-starting again.
