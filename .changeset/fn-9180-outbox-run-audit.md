---
"@runfusion/fusion": patch
---

summary: Keep deleted-task outbox delivery resilient when audit telemetry fails.
category: fix
dev: Routes catch-up, reconciliation-fallback, lease-fenced, and retention-pruned through the core bounded audit seam.
