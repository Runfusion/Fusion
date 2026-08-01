---
"@runfusion/fusion": patch
---

summary: Archived-task document rules now work on boards that rename the archived lane.
category: fix
dev: `upsertTaskDocument` and `publishArchivedTaskDocumentAddition` compared `task.column` against the literal `"archived"`. On a renamed archived lane the first failed to reject (an archived card's documents stayed writable) and the second failed to accept (a legitimate archived-document publication was refused as `parent-not-archived`). Both now take a resolved archived-lane set, supplied by their store-level impls.
