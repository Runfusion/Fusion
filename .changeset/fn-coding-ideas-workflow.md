---
"@runfusion/fusion": minor
---

summary: Add a "Coding (Ideas)" workflow with a manual Ideas intake and a merged Todo planner column.
category: feature
dev: New `builtin:coding-ideas` clones the default stepwise pipeline with an `ideas` intake (autoTriage:false) in front of a merged `todo` planner+capacity column. createTask lands cards in the workflow's intake column; the triage service plans unplanned todo tasks in place; the scheduler skips bootstrap-prompt todo tasks; TaskCard gains a Start button and a Ready badge.
