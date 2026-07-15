---
"@runfusion/fusion": patch
---

summary: Speed up dashboard and serve startup by sharing the PostgreSQL store and deferring non-route work.
category: performance
dev: Dashboard injects externalTaskStore for cwd engine (serve parity); multi-project engines only share when working directories match. ProjectEngine defers notifiers/OAuth (refresh-before-monitor), automation syncs, and merge sweep. Serve no longer awaits startAll before listen. Phase timing logs on both surfaces.
