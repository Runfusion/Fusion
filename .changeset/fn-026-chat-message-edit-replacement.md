---
"@runfusion/fusion": patch
---

summary: Replace chat message edits with one atomic rewind-and-resend operation.
category: fix
dev: Retires the destructive PATCH edit transport in favor of replacement-aware SSE with trimmed content and acceptance-gated reconciliation.
