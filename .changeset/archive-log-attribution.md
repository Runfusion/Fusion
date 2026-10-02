---
"@runfusion/fusion": patch
---

summary: Attribute cold-archive log entries with caller class, agent, and origin column.
category: fix
dev: `taskToArchiveEntryImpl` now accepts the shared `TaskDeleteAuditContext` and writes
`Task archived from <column> by <callerKind> (<agentId>)` instead of the anonymous
`Task archived`. The archive funnel (`archiveTask` → `archiveTaskBackend` → archive
entry) threads the optional context; dashboard archive routes derive it from the
`x-fusion-client` header exactly like delete, the CLI tags `operator-cli`, the agent
tool tags `agent-tool`, and the self-healing retention sweep tags `engine`. Callers
that pass nothing keep the `api-unattributed` default.
