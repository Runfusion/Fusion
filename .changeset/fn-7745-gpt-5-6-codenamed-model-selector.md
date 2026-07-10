---
"@runfusion/fusion": minor
---

summary: GPT-5.6 codenamed models (luna, sol, terra) are now selectable in the model picker.
category: feature
dev: Adds mergeSupplementalOpenAiCodexModels in @fusion/core, invoked from GET /api/models alongside the Anthropic supplemental merge; additive and deduped against the pinned pi-ai catalog, gated by the configured openai-codex provider.
