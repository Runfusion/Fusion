---
"@runfusion/fusion": minor
---

summary: Archived tasks now load newest-first in pages of 100 with a Show more button.
category: feature
dev: Adds ArchiveDatabase.listPage / TaskStore.listArchivedTasks and GET /tasks/archived for a bounded SQL LIMIT/OFFSET read ordered archivedAt DESC. useTasks.loadArchivedTasks fetches page 1 on first Archived-column expand; loadMoreArchivedTasks fetches subsequent pages. No schema change; the legacy merged listTasks({includeArchived}) path is unchanged.
