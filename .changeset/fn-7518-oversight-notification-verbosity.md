---
"@runfusion/fusion": minor
---

summary: Add a configurable planner-overseer notification verbosity level (Silent/Errors/Important/All).
category: feature
dev: New workflow-native enum setting `plannerOversightNotificationLevel` in BUILTIN_OVERSIGHT_SETTINGS; default `important`. Resolves via resolveEffectiveSettings; emission gating that reads it lands in FN-7519/FN-7520.
