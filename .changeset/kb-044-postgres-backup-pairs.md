---
"@runfusion/fusion": patch
---

summary: Fix PostgreSQL backup pair listing and restore both control-plane dump halves safely.
category: fix
dev: Native restore now validates paired dumps, retains a pre-restore pair, and uses per-half transactional rollback.
