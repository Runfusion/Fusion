---
"@runfusion/fusion": patch
---

summary: Stale agent task links no longer stop self-healing from reconciling later agents.
category: fix
dev: Harden recoverAgentsRunningOnInactiveTasks and recoverDriftedAgentTaskLinks with isMissingTaskLookupError/readLinkedTaskOrUndefined for Runfusion/Fusion#3397.
