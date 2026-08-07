---
"@runfusion/fusion": patch
---

summary: Fix a startup deadlock that made the dashboard stop responding to all requests.
category: fix
dev: `provisionBuiltinWorkflowRoleAgents` (FN-8764) held a `pg_advisory_xact_lock` transaction while running its reads/writes on the pool, requiring a second connection. With concurrent callers blocking on the same lock and `DEFAULT_POOL_MAX=3`, the pool self-deadlocked and every DB-backed API route queued forever. `listAgents`/`findAgentByName`/`createAgent`/`writeAgent` now accept an optional `QueryHandle` so the provisioning work runs on the locking transaction.
