---
"@runfusion/fusion": patch
---

summary: Align per-step review coding with default coding gates and session settings.
category: fix
dev: Removes the extra generic review seam from Coding (per-step review) and makes StepSessionExecutor honor runStepsInNewSessions=false by reusing the primary sequential session while keeping graph step-review boundaries.
