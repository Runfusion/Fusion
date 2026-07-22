---
"@runfusion/fusion": patch
---

summary: Automatically retry interrupted Planning sessions when operators return to them.
category: fix
dev: Uses session-scoped retry ownership across persisted, polled, and SSE error recovery.
