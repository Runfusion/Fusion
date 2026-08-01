---
"@runfusion/fusion": patch
---

summary: Refined and duplicated tasks land in the workflow's Planning column instead of a deleted legacy column.
category: fix
dev: task_refine (update-task-deps.ts) and task_duplicate (project-store-ops.ts) hardcoded column "triage"; both now resolve resolveWorkflowIntakeFacts().intake with the literal as last resort. Symptom: amber PLANNING badge (badge color keys off raw column id) on cards in an undeclared column.
