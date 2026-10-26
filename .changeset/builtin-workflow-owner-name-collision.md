---
"@runfusion/fusion": patch
---

summary: Keep every workflow role staffed when an existing agent already uses a built-in owner's name.
category: fix
dev: provisionBuiltinWorkflowRoleAgents falls back to "<name> (built-in)" on a name collision and skips only the affected role instead of aborting, which previously left a project with no triage principal.
