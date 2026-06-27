---
"@runfusion/fusion": minor
---

summary: Agents now receive more tools, with dangerous actions governed by each agent's permission policy.
category: feature
dev: Heartbeat agent-work lane (packages/engine/src/agent-heartbeat.ts) assembles the broadened toolset; access remains gated by AgentPermissionPolicy via wrapToolsWithActionGate. Hermetic readonly lanes and automation allowedTools are unchanged.
