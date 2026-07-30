---
"@runfusion/fusion": patch
---

summary: A provider rate limit now pauses every task actually running on that provider, including on renamed boards.
category: fix
dev: `taskUsesProvider`'s executor and merger lane checks resolve the workflow's wip/review columns (from the same per-workflow IR cache the planner lane already uses) instead of comparing against `"in-progress"`/`"in-review"`; both fail soft to the legacy literal.
