---
"@runfusion/fusion": patch
---

summary: Back off idle task-lifecycle outbox consumers to a 60s cadence so paused/idle projects stop the 98% CPU poll storm.
category: performance
dev: TaskDeletedOutboxConsumer now self-reschedules with a tri-state poll outcome (active/idle/waiting) and ±20% jitter: only a genuinely idle poll (empty outbox) grows the next delay by 10s per idle poll toward a 60s cap; a poll that delivers events ("active") or a non-idle wait ("waiting" — retry-backoff window, lease contention, fencing, poll errors, shutdown races) resets to the fast 5s base, so transient failures recover at 5s cadence instead of an error streak masquerading as an idle streak. This targets a drop in task_lifecycle_consumer_cursors idx_scan from ~26/s toward <5/s and CPU from ~98% toward <50% when projects are paused/idle (the ~44 per-project dashboard+engine consumers no longer thunder on a fixed 5s interval), while cursor fencing, lease advance, per-event ordering, and at-least-once delivery are unchanged — backoff only changes when poll() runs, never the poll/dispatch/ack logic. A new event mid-backoff resets the cadence to 5s, bounding delivery latency.