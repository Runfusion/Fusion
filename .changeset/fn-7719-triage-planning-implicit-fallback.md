---
"@runfusion/fusion": patch
---

summary: Triage recovers automatically when the planning model hits a provider 404/429 and no fallback is set.
category: fix
dev: TriageProcessor.specifyTask now derives an implicit fallback from the project/global default (execution) model when no planningFallback*/global fallback* pair is configured, so a retryable primary planner-model failure swaps once instead of failing triage with "no fallback configured". Test mode and self-swap are excluded; the single-swap ModelFallbackExhaustedError terminal path is preserved.
