---
"@runfusion/fusion": patch
---

summary: Honor assigned agent models in execution and warn on default-model fallbacks.
category: fix
dev: Executor assigned-agent lookup now falls back to the root AgentStore; session audit adds noModelResolved/runtimeBuiltInFallbackModel when resolution is empty.
