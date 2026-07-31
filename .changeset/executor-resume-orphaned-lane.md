---
"@runfusion/fusion": patch
---

summary: Orphaned tasks are resumed after a restart on boards with renamed columns.
category: fix
dev: `resumeOrphaned` read the wip lane by role via `listWipLaneTasks()` but its filter still compared `t.column === "in-progress"`, so on a renamed board the read found the orphans and the filter discarded all of them. The filter now tests membership of the resolved wip columns.
