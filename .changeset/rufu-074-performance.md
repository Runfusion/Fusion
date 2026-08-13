---
"@runfusion/fusion": patch
---

summary: Back off idle task-lifecycle outbox consumers to a 60s cadence so paused/idle projects stop the 98% CPU poll storm.
category: performance
dev: TaskDeletedOutboxConsumer now self-reschedules with idle backoff + ±20% jitter: an idle poll (outbox empty, cursor not advancing) grows the next delay by 10s per idle poll toward a 60s cap; a poll that delivers events resets to the fast 5s base. This drops task_lifecycle_consumer_cursors idx_scan from ~26/s to <5/s and CPU from ~98% to <50% when projects are paused/idle (the ~44 per-project dashboard+engine consumers no longer thunder on a fixed 5s interval), while cursor fencing, lease advance, per-event ordering, and at-least-once delivery are unchanged — backoff only changes when poll() runs, never the poll/dispatch/ack logic. A new event mid-backoff resets the cadence to 5s, bounding delivery latency.