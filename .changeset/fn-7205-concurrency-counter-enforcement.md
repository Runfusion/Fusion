---
"@runfusion/fusion": patch
---

summary: Concurrency panels now prefer live engine counts so running-agent totals stay accurate.
category: fix
dev: Prefer engine-manager task stores over stale registered/default fallback stores in the dashboard live-count source; add regressions for count normalization and scoped semaphore live-limit behavior.
