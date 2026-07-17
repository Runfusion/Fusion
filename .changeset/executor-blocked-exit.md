---
"@runfusion/fusion": patch
---

summary: Executors can end a genuinely-impossible task as "blocked" instead of laundering it into done.
category: fix
dev: fn_task_done gains outcome="blocked" (plus reason + optional blockedBy). Blocked parks the task failed (error "BLOCKED: <reason>"), bypasses the completion/bulk-completion gates, keeps steps in their true statuses, records blockedBy as task.dependencies, and emits run-audit task:execution-blocked-parked. Prompt guidance now names the blocked exit as the correct escape hatch, replacing skip-then-complete. Motivating incident: FN-8141.
