---
"@runfusion/fusion": patch
---

summary: Board lanes and the list view now sort by each column's role, so renamed boards keep their card order.
category: fix
dev: `Lane` and `ListView` pass the resolved `isArchivedColumn`/`isHoldColumn`/`isCompleteColumn`/`isReviewColumn` traits to `sortTasksForDisplayColumn`, mirroring Board.tsx; previously they used the helper's legacy-id defaults.
