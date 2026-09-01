---
"@runfusion/fusion": patch
---

summary: Workflow lists now reflect workflow edits immediately without a daemon restart.
category: fix
dev: Removed TaskStore.workflowDefinitionsCache; readAllWorkflowDefinitionsImpl now reads through on every call.
