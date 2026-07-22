---
"@runfusion/fusion": patch
---

summary: Allow freeform chat task creation without mission lineage.
category: fix
dev: `fn_task_create` / `fn_delegate_task` only hard-require approved `mission_lineage` when registered with `requireMissionLineage` (idle heartbeat patrol). User-directed chat/create paths may omit lineage; gates no longer pre-block missing lineage so freeform intake remains policy-governed.
