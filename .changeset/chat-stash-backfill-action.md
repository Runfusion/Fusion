---
"@runfusion/fusion": minor
---

summary: Add a per-chat "Preserve to Stash" action that backfills a chat's full history into Stash.
category: feature
dev: New `POST /api/chat/sessions/:id/backfill-stash` route reuses the live-capture `captureMemory`
path (per-project session folder, real per-message `created_at` timestamps instead of upload time).
Idempotent via a client-side pre-check: Stash's `/events/batch` is a bare INSERT with no
server-side dedupe (verified against the backend source and live — the same backfill twice
took a session 4 -> 8 -> 12 events), so the route pages the session's existing events and
skips messages whose content is already stored; re-runs and backfill-after-live-capture
insert nothing new. The chat context menu shows the action only when the project memory
backend is Stash.
