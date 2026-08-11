---
"@runfusion/fusion": patch
---

summary: Fix Fusion hanging on startup — spec-drift reconciliation exhausted the database connection pool.
category: fix
dev: `SpecDriftReconciler.enqueue` released every id into its own microtask, and each reconcile costs a DEDICATED PostgreSQL connection (`appendSpecDriftReport` -> `withPlanningLifecycleLock` opens its own session-scoped `max: 1` client). `project-engine.ts` enqueues every task at runtime-boundary setup, so a 1,082-task project opened ~1,082 lock sessions at once against `max_connections = 500`, saturating the cluster ~25s into boot; every later query then failed with "sorry, too many clients already" and the dashboard wedged on "starting" behind the migration holding server. The flat 1s retry made it self-sustaining (measured 4,777 lock sessions in 17s). Adds a concurrency bound (`maxConcurrent`, default 4) with a fair insertion-ordered pump, per-task in-flight dedupe, and exponential backoff with jitter capped at 60s; retries re-enter through `enqueue` so they are bounded too. Verified against the real project: connections stay flat at 3-10 across a 70s boot that previously hit 1,109 and saturated.
