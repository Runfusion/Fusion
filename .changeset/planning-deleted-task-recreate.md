---
"@runfusion/fusion": patch
---

summary: Deleting a task created from a plan no longer dead-ends the plan — Proceed creates a fresh task.
category: fix
dev: `PLANNING_CREATED_TASK_MISSING` now only fires when the linked task is still listed but unreadable (transient read); a task absent from the include-archived scan clears the stale linkage in both the create-task route and `createTaskFromPlanSession`. CLI/agent create side-effect failures are now logged; keep-refining readline closes on thrown prompts.
