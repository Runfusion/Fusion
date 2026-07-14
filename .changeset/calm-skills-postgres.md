---
"@runfusion/fusion": patch
---

summary: Fix dashboard skill discovery in PostgreSQL mode.
category: fix
dev: Reuse backend-aware project stores so skill discovery never falls through to the removed synchronous SQLite PluginStore and TaskStore paths.
