---
"@runfusion/fusion": patch
---

summary: Retry unavailable Plan Review without rewriting existing task specs.
category: fix
dev: plan-review-unavailable triage tasks now rerun Plan Review/finalization from the existing PROMPT.md under global agent concurrency instead of launching the planner.
