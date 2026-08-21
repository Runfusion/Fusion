---
"@runfusion/fusion": patch
---

summary: Keep Stash chat backfill complete when message timestamps tie.
category: fix
dev: getChatMessages now orders by (created_at, id), making the backfill route's offset pagination a total order — equal created_at values can no longer duplicate or drop messages across page boundaries (PR #3494 review, Greptile P1).
