---
"@runfusion/fusion": patch
---

summary: Planner-overseer task badge now shows a readable label and explains what it is waiting on.
category: fix
dev: TaskCard badge renders plannerOverseerStateLabel + plannerOverseerBadgeTooltip built from the existing PlannerOverseerRuntimeSnapshot (reason/watchedStage/signal/pendingConfirmation); presentation-only, no engine changes.
