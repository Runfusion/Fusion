---
"@runfusion/fusion": minor
---

summary: fn_task_archive and fn_task_delete now accept removeLineageReferences to clear a lineage-parent block.
category: fix
dev: Forwards the boolean to store.archiveTask/deleteTask (FN-7661); resolves the tools referencing a parameter their schema never exposed.
