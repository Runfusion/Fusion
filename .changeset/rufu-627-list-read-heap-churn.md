---
"@runfusion/fusion": patch
---

summary: The dashboard and engine now share one in-flight board read instead of parsing the same board once per waiting consumer.
category: performance
dev: Adds `ListTasksOptions.coalesce` (default `true` for non-paginated reads) plus `TaskStore.listReadInFlight` / `clearListReadCaches()`; a shared board list is frozen at fill, and idempotency lookups pass `coalesce: false`. Adds `ListTasksOptions.fields` with the closed `TaskListReadField` union so a caller declares the wide fields it reads and the SELECT stops carrying the others; absent `fields` keeps today's projection by reference, a declared set is a read-shape key dimension, and a `slim` read that does not declare `steps` no longer re-parses PROMPT.md per card. The in-flight/memo shape key also gained the `slim`, effective-log, `compactBoardFeed` and `fields` dimensions it was missing — overlapping `slim` and non-`slim` reads were sharing one fetch. The auto-claim snapshot now retains ids and queue scalars only (`RetainedAutoClaimCandidate`), so the card text a consumer may only read after canonical re-resolution is no longer cached, and the snapshot's rebuild read declares zero wide fields. The `heap:floor` probe remains open on RUFU-627.
