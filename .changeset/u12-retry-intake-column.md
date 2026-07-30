---
"@runfusion/fusion": patch
---

summary: Retry now works for planning cards on boards whose first column isn't named "triage".
category: fix
dev: register-task-workflow-routes.ts resolves the intake column via columnsWithFlag(ir,"intake") instead of comparing task.column to the literal "triage"; 7 lifecycle-column comparisons in the file drop to 1 (comment text).
