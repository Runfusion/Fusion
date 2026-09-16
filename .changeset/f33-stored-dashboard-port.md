---
"@runfusion/fusion": patch
---

summary: Honor the configured dashboard port when no explicit CLI port is provided.
category: fix
dev: Dashboard startup now falls back to the canonical stored daemonPort before the 4040 default, while explicit --port/-p remains authoritative.
