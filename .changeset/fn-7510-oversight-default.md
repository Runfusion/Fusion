---
"@runfusion/fusion": minor
---

summary: Planner oversight now defaults to full steering/control for every workflow unless explicitly changed.
category: feature
dev: Confirms the `plannerOversightLevel` workflow-setting default is the highest (autonomous) level; unset workflow value and unset per-task override both resolve to full steering via `resolveEffectivePlannerOversightLevel` (task override → workflow effective value → autonomous), adding dedicated regression coverage for the "unless explicitly disabled" precedence.
