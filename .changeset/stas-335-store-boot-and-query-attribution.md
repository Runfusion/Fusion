---
"@runfusion/fusion": patch
---

summary: A stalled store boot or failed board query now names its stage, table and SQLSTATE instead of a silent 30 s hang.
category: fix
dev: `createTaskStoreForBackend` reports every boot stage through an optional `onBootStage` observer (the `onMigrationProgress` precedent); the extension collects the stages of the attempt a caller was waiting on, appends `Boot attribution: <phase>=<ms> … (elapsed Nms of the Nms budget).` to both deadline shapes, carries `details.bootStages` / `details.elapsedMs`, and records them on the cooldown entry so a caller inside the backoff learns where the abandoned attempt stalled. That text is credential-safe by construction: phase labels and durations, never SQL text, bound parameters, connection URLs or a driver's `detail`. On the query side `describeStoreQueryFailure` reads Drizzle's wrapper structurally (`query` + `cause.code`, never `params`) and `storeErrorResult` appends `[statement= table= sqlState=]` with `details.operation` stating whether a read lost nothing or a write persisted nothing — including the agent-roster read, which had no catch and threw the raw wrapper past the tool boundary. No budget was raised, no retry loop or fallback handle added, and the teardown rule that only the process which started the embedded PostgreSQL may stop it is unchanged.
