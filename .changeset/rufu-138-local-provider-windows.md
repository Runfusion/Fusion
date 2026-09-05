---
"@runfusion/fusion": minor
---

summary: Auto-detect context windows for local Ollama, LM Studio, and vLLM custom providers.
category: feature
dev: The custom-provider probe now reads max_model_len (vLLM, with LoRA parent inheritance), max_context_size (LM Studio), and Ollama native /api/tags + /api/show model_info context lengths on the trusted refresh path; detected windows persist via the RUFU-123 per-model id-merge. Browser Detect Models SSRF posture is unchanged.
