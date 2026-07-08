---
"@runfusion/fusion": patch
---

summary: Built-in workflow boards and Automations editors now label the intake column "Planning", not "Triage".
category: fix
dev: board-workflows canonical label map BUILTIN_WORKFLOW_COLUMN_LABELS.triage was still "Triage", overriding FN-7599's IR rename; set to "Planning". English schedule.columnTriage/taskColumnTriage/triageColumn set to "Planning" and dashboard locale copy re-synced. Also fixed board.triage (AgentDetailView task-column badge) and docs/dashboard-guide.md references. Column id "triage" unchanged.
