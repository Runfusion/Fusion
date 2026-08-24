---
"@runfusion/fusion": patch
---

summary: Prevent non-executor audit telemetry failures from interrupting engine recovery and merge work.
category: fix
dev: Moves bounded audit isolation to a shared engine seam; createRunAuditor no longer propagates sink rejections.
