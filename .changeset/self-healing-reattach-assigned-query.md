---
"@runfusion/fusion": patch
---

summary: Idle assigned agents are reattached to their work on boards with renamed columns.
category: fix
dev: `reattachOrphanedAssignedExecutions` read the literal `in-progress`, so on a renamed board an agent that stopped executing a task it was still assigned to was never resumed, leaving the card assigned-but-idle. Read resolves via `resolveProjectColumnsForRoles`, per-card check resolves per card.
