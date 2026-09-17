---
"@runfusion/fusion": patch
---

summary: Column headers now show only the number of tasks in the column.
category: fix
dev: Column.tsx drops the activeTaskCount memo and the column.executingOfTotal label; aria-label unifies on column.taskCount.
