---
"@runfusion/fusion": patch
---

summary: Workflows without a merge step now finish in their completion column instead of stalling one column short.
category: fix
dev: `end` is a graph terminal and never a column destination (KTD-1), so a card only entered the `complete`-trait column when a real node lived there — true for merge-bearing workflows via `post-merge-verification`, false for any no-merge workflow (e.g. Lead Generation stranded in `outreach`, never `converted`, which also blocked its dependents). Adds `advanceNoMergeWorkflowToCompleteColumn` on the executor's completed-disposition branch, keyed on the absence of a merge-orchestration column so merge-bearing workflows are untouched and `done` still requires a confirmed merge.
