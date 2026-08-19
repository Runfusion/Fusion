---
"@runfusion/fusion": minor
---

summary: Add a per-chat "Preserve to Stash" action that backfills a chat's full history into Stash.
category: feature
dev: New `POST /api/chat/sessions/:id/backfill-stash` route reuses the live-capture `captureMemory` path (content-hash dedupe, per-project session folder, real per-message timestamps instead of upload time). The chat session context menu shows the action only when the project memory backend is Stash; idempotent, so re-running after partial live capture never double-writes.
