---
"@runfusion/fusion": patch
---

summary: Stop retrying impossible auto-archives forever and surface abandoned archives on the task.
category: fix
dev: archiveStaleDoneTasks pre-filters live lineage parents and uses MAX_STARVATION_DROPS with task:auto-archive-failure-budget-exhausted.
