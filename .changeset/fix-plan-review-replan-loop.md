---
"@runfusion/fusion": patch
---

summary: Plan Review revisions no longer loop forever; tasks escalate to approval after repeated revises.
category: fix
dev: The triage pre-execution plan-review gate now seeds replan feedback from the plan-review REVISE output in workflowStepResults and caps consecutive REVISE replans at 3 (new planReviewReplanCount counter — a plan_review_replan_count integer column on the PostgreSQL tasks table, self-healing on existing embedded-PG databases via postgres-health), routing the task to awaiting-approval instead of looping.
