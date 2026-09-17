---
"@runfusion/fusion": minor
---

summary: Task Detail Plan adds a Before/After section and drops the Copy, Open PROMPT.md and Edit actions.
category: feature
dev: TaskDetailModal renders `extractTaskBeforeAfterTransformation` output as `detail-definition-transformation` below the outcome (skipped when the outcome already fell back to that body). Definition blocks become token-only cards and the step disclosure reuses `detail-source-toggle` beside the progress bar. The plan sub-view is read-only: the inline spec editor, its `Ask AI to Revise` composer, the plan-copy state and the `taskDetail.spec.*` keys they used are removed; `SpecEditor` is untouched.
