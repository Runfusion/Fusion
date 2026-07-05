---
"@runfusion/fusion": patch
---

summary: Anthropic subscription reads now refresh the OAuth token automatically instead of silently failing when expired.
category: fix
dev: mergeAuthStorageReads getApiKey("anthropic-subscription") now delegates to the underlying engine authStorage.getApiKey (the only refresh-token HTTP round trip) instead of a local static expiry check; regression tests drive the wrapper directly. No token material logged.
