---
"@runfusion/fusion": minor
---

summary: Add Follow-up to create a linked successor task from a task that is still running.
category: feature
dev: New `POST /api/tasks/:id/follow-up` route and `TaskStore.refineTask(id, feedback, { mode: "follow-up" })`. The child is persisted as a `task_refine` sub-type via a versioned `sourceMetadata.followUp` marker with a real dependency edge, so lineage readers, delete guards, and stranded-refinement recovery are unchanged and no migration is required. Eligibility (WIP, review, and planning only with a current approving `plan-review` result) lives once in `tasks/task-follow-up.ts` and is shared by the menu, the store, and the route. In review-lane context menus Follow-up REPLACES the Refine entry rather than adding a second one; Refine is unchanged for completed tasks, and the existing `/api/tasks/:id/refine` route, CLI tools, and chat refinement callers keep their exact contracts. Triage injects the source task's plan and progress into the follow-up's planning prompt, and spec finalization no longer drops the source dependency edge.
