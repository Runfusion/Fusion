---
"@runfusion/fusion": minor
---

summary: Per-model thinking-format flag and "No thinking params" opt-out for custom providers.
category: feature
dev: Custom-provider model rows (Settings → Authentication → Custom Providers and the legacy Model Onboarding form) now persist an optional pi-ai `thinkingFormat` per model (UI-safe values: `qwen-chat-template`, `qwen`, `zai`, `deepseek`, `string-thinking`, `openrouter`, `together`, `ant-ling`) and a `reasoning: false` opt-out. Unflagged models register byte-identical to before. The dashboard select deliberately omits `openai` (identical to the default) and raw `chat-template`/`baseten` (require `chatTemplateKwargs`/`chatTemplateArgs`, manual `models.json` only); the route validator accepts the full union so non-UI-safe persisted values round-trip unchanged.
