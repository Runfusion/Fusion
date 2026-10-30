---
"@runfusion/fusion": patch
---

summary: Forced-open scheduler passes now leave a durable audit row, not just a log line.
category: internal
dev: New `scheduler:pass-stalled` run-audit event, one row per stall episode, with `leg`, `inFlightMs`, `thresholdMs`, `outcome`. Emitted through the bounded seam; the log sentence from RUFU-828 is unchanged. No lifecycle behaviour changes.
