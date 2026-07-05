---
"@runfusion/fusion": minor
---

summary: Add a Settings → General picker to choose the workflow used for AI-undo (revert) tasks.
category: feature
dev: Surfaces `aiUndoTaskWorkflowId` (default `builtin:review-heavy`) in GeneralSection; empty selection means "inherit project default workflow", matching the revert route's blank-is-inherit behavior from FN-7556.
