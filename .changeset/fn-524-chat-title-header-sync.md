---
"@runfusion/fusion": patch
---

summary: Renaming a conversation now updates its window header immediately, not just the list row.
category: fix
dev: useChat applies the deferred title on every authoritative-refresh exit path (divergent id, missing isGenerating boolean, transport failure) and arms the deferral for cleared titles; the allowlist stays closed on `title`.
