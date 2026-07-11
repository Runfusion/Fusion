---
"@runfusion/fusion": patch
---

summary: Usage view now hides Gemini when it isn't configured for metering or its login has expired.
category: fix
dev: fetchGeminiUsage() in packages/dashboard/src/usage.ts reclassifies the unsupported-auth-type (api-key/vertex-ai) and HTTP 401/403 outcomes from error→no-auth so fetchAllProviderUsage omits Gemini; transient failures (HTTP 5xx/network/timeout) of a configured token remain visible as error.
