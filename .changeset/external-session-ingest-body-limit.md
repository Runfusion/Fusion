---
"@runfusion/fusion": patch
---

summary: Accept remote-agent session turns larger than 100 KB instead of rejecting them and stalling later turns.
category: fix
dev: The two external-session ingestion routes use a dedicated 2 MiB + 1 KiB JSON parser matching the collector's turn cap; other routes keep their limits.
