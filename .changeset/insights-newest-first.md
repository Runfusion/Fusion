---
"@runfusion/fusion": patch
---

summary: Insights now list newest first instead of oldest first.
category: fix
dev: Ordering is applied in `useInsights` section grouping; `InsightStore.listInsights` keeps its `createdAt ASC, id ASC` contract.
