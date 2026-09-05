---
"@runfusion/fusion": minor
---

summary: Per-model HTTP timeout (seconds, 0=off) for custom providers; stops local slow models hitting the 5-minute timeout
category: feature
dev: Custom provider `models[]` now accepts `timeoutSeconds` (HTTP idle/first-byte bound: request→first byte and between chunks; omitted keeps the 300s default, 0 disables). The engine applies it at two layers: the per-session OpenAI SDK first-byte timeout (pi SettingsManager `retry.provider.timeoutMs`) and the process-global undici dispatcher's per-origin `bodyTimeout`/`headersTimeout` (most permissive value wins per origin, reinstalled on startup and provider save).
