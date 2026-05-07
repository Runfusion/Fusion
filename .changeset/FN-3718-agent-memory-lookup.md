---
"@runfusion/fusion": patch
---

Fix agent memory lookup: the system prompt's "## Agent Memory" section and the
heartbeat Identity Snapshot now read from the on-disk agent-memory workspace
(`.fusion/agent-memory/{agentId}/MEMORY.md`) when the inline `agent.memory`
field is empty, matching the documented contract.
