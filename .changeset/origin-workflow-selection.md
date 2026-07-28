---
"@runfusion/fusion": minor
---

summary: Pick the workflow for CLI/agent-created and refinement tasks, and title refinements by your own feedback.
category: feature
dev: Adds project settings `taskCreateWorkflowId` and `refinementTaskWorkflowId` (blank/unset = "Selected workflow"), plus `boardSelectedWorkflowId`, a dashboard-written mirror of the current Board lane so non-browser callers can resolve that option. Resolved by `TaskStore.resolveOriginWorkflowOverrideId(origin)` — pinned setting, then mirrored lane, then `undefined` to inherit the existing project-default path; an unknown or fragment id degrades to inherit. Consumed by `fn task create`, `fn_task_create` (an explicit `workflow_id` argument still wins), and `refineTask`. New route `PUT /api/project/board-selected-workflow`. Separately, `refineTask` now titles the new card with `deriveFallbackTaskTitle(feedback)` instead of `Refinement: <source title>`, and TaskCard renders a `Refines <id>` provenance chip.
