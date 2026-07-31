---
"@runfusion/fusion": patch
---

summary: Board no longer re-renders every column and card when you collapse Archived or change Done sort.
category: performance
dev: `canDropTask` was allocated as an inline arrow per column per render, defeating `React.memo(Column)` so any Board state change re-rendered all columns and their cards. Bound through a `useMemo` cache keyed by lane+column. The "keeps unaffected columns stable" test is un-skipped and now guards the real workflow board — it previously measured the deleted legacy board.
