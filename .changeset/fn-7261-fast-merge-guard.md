---
"@runfusion/fusion": patch
---

summary: Prevent fast workflow merges from completing before implementation steps run.
category: fix
dev: Blocks stale no-op merge proof from trapping unfinished workflow tasks and requeues premature merge-node failures.
