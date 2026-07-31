---
"@runfusion/fusion": minor
---

summary: Remove the machine-wide concurrency cap — capacity is now two numbers per project.
category: breaking
dev: Deletes `globalMaxConcurrent` (settings key, CentralCore state API, `PUT /api/global-concurrency`, the Scheduling · Global settings section, and the footer + Command Center global sliders). `GET /api/global-concurrency` survives but returns live telemetry only (`currentlyActive`, `projectsActive`); it no longer reports `globalMaxConcurrent`/`queuedCount`, which came from slot bookkeeping production code never incremented. `acquireGlobalSlot`/`releaseGlobalSlot` had no production callers and are gone. Scheduling · Global and Scheduling · Project merge back into one "Scheduling" section. A stored `globalMaxConcurrent` is ignored; the `central.global_concurrency` table is dropped in a follow-up.
