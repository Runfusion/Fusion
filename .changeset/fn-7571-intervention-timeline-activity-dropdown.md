---
"@runfusion/fusion": patch
---

summary: Move the planner intervention timeline into the task Activity view dropdown.
category: feature
dev: Removes the inline `PlannerInterventionTimeline` mount from the FN-7517 oversight cluster in `TaskDetailModal.tsx` and adds a fourth `interventions` `ActivitySegment`, shown in the Activity dropdown only when planner oversight is active for the task; falls back to Live if oversight turns off while Interventions is selected.
