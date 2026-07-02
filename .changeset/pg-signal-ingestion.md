---
"@runfusion/fusion": fix
---

summary: Incident-signal ingestion records incidents on the PostgreSQL backend instead of being skipped.
category: fix
dev: ingestIncidentSignal now accepts Database | AsyncDataLayer and branches to ingestIncidentSignalAsync (project.incidents upsert by grouping key — absorb-or-create, occurrences/firstFiredAt preserved) in PG mode; the signal route awaits it instead of warn-skipping. monitor-trait's storm-guard helpers remain sync-only (async equivalents exist; follow-up).
