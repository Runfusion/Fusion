---
"@runfusion/fusion": minor
---

summary: Chat sessions now expose the full permission-mapped task toolset for gated agents.
category: feature
dev: createChatFusionToolset binds fn_task_archive/unarchive/delete/retry/pause/unpause/duplicate/merge only when an enforceable actionGateContext is present (wrapToolsWithActionGate is a pass-through without a gate, so ungated registration would bypass task_agent_mutation policy). Adds 10 task-lifecycle tool factories to @fusion/engine agent-tools. fn_task_update/add_dep/promote are intentionally not bound in project-scoped chat (no ambient task id). fn_read_evaluations degrades to ratings-only (no ReflectionStore in chat); fn_reflect_on_performance is omitted (no AgentReflectionService). Regression tests assert the gated surface, the withheld surface without a gate, and absence of ambient-task tools.
