---
"@runfusion/fusion": patch
---

summary: Stop the usage telemetry log from growing without bound and bloating the Fusion database.
category: fix
dev: usage_events was absent from operational-log retention, so it grew unbounded (observed ~187k rows / ~28MB with nothing ever aged out). pruneOperationalLogs now prunes usage_events on the same operationalLogRetentionDays cadence, keyed off its `ts` column (not `timestamp`). Existing rows still require a one-time VACUUM to reclaim on-disk space.
