---
"@runfusion/fusion": minor
---

summary: Add a Patchnode view with a searchable, permanent daily log of completed and reverted tasks.
category: feature
dev: New project.patchnode_entries table (migration 0071) keyed per completion occurrence so re-deliveries each get their own dated entry. Completion entries are written inside the move transaction in both completion writers because columnMovedAt is overwritten by the next move. No FK to tasks and no row expiry, so entries outlive archive cleanup; reads never join tasks. Archive and cleanup capture pre-Patchnode backlog, and reconciliation re-arms on a TTL. Adds GET /api/patchnode and the read-only fn_patchnode_read chat tool.
