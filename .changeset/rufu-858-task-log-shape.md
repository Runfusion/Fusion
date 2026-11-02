---
"@runfusion/fusion": patch
---

summary: Fix task-history rows being written as JSON scalars, which made board reads fail after succeeding.
category: fix
dev: `tasks.log` writers now go through `toJsonArray()`/`coerceTaskLogArray()`, which heal a double-encoded array and refuse any other shape instead of writing a jsonb scalar; two such rows (RUFU-235, SANE-616) made every `select id, log` over a project throw, so `fn task delete` reported failure after committing and `fn task create` created nothing.
