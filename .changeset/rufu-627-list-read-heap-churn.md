---
"@runfusion/fusion": patch
---

summary: The dashboard and engine now share one in-flight board read instead of parsing the same board once per waiting consumer.
category: performance
dev: Adds `ListTasksOptions.coalesce` (default `true` for non-paginated reads) plus `TaskStore.listReadInFlight` / `clearListReadCaches()`; a shared board list is frozen at fill, and idempotency lookups pass `coalesce: false`. Declared field sets, the capacity fan-out and the `heap:floor` probe remain open on RUFU-627.
