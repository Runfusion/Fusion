---
"@runfusion/fusion": patch
---

summary: Fix tasks stalling forever in progress with no session after the workflow role-agent rollout.
category: fix
dev: Two deadlocks in FN-8764's role routing, both silent. (1) The in-process runtime never passed its AgentStore into `TaskExecutorOptions`, so routing failed closed at every role-classified node. (2) Durable continuation writes used a bare `upsertWorkflowWorkItem`, whose ON CONFLICT target is not `idx_workflow_work_items_one_active_task_continuation`, so a predecessor the run had already left (the resumed continuation, or a sibling foreach instance sharing the template nodeId) made the write RAISE; the run then re-suspended every dispatch until an operator bounced the card. Every `kind:"task"` continuation write in the executor and triage now goes through the atomic `replaceActiveTaskWorkflowContinuation`. Adds the `task:workflow-run-suspended` run-audit event, logs principal holds and fence-write errors instead of swallowing them, pins the invariant against a real Postgres index, and ratchets the hand-rolled handover as a tombstone.
