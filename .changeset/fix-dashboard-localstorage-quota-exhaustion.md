---
"@runfusion/fusion": patch
---

summary: Fix dashboard localStorage quota exhaustion from stale SWR caches and add a Clear local data escape hatch.
category: fix
dev: Stale SWR hydration entries (per-chat-session/per-room message caches) were never garbage-collected; readCache now lazily deletes stale entries, a boot sweep prunes anything older than 24h, and Settings → General exposes a user-facing "Clear local data" button that preserves the auth token.
