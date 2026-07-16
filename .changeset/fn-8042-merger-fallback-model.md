---
"@runfusion/fusion": minor
---

summary: Add a dedicated fallback model lane for the AI merger, configurable under Project Models.
category: feature
dev: New project settings mergerFallbackProvider/mergerFallbackModelId/mergerFallbackThinkingLevel; resolveMergerFallbackModel resolves project merger-fallback → global fallbackProvider/fallbackModelId. Every merger session builder consumes the resolved merger fallback pair and lane-specific fallback thinking; unset keys preserve existing behavior.
