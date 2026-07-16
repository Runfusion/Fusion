---
"@runfusion/fusion": minor
---

summary: Pin up to 3 chat conversations to keep important ones at the top.
category: feature
dev: Adds nullable chat_sessions.pinned_at (self-heals on boot); PATCH /chat/sessions/:id accepts `pinned`; ChatStore.setSessionPinned enforces the max-3 per-project-scope limit (null projectId scoped as "default" via isNull predicate + non-null advisory-lock key) with a per-scope advisory lock; archiving clears pinnedAt on both archive paths and archived sessions cannot be pinned.
