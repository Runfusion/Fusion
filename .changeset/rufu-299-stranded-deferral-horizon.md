---
"@runfusion/fusion": patch
---

summary: A stranded workflow hold can no longer stay hidden from its own recovery sweep for more than 7 days.
category: fix
dev: Adds `workflow_work_items.deferred_since` (migration `0095`, schema baseline `0095`) as the durable deferral-episode anchor, a 7-day reveal horizon, and the `workflowWorkItem:reconcile-stranded-defer-sustained` / `workflowWorkItem:reconcile-stranded-revealed` run-audit events. No setting is added or removed.
