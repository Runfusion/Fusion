---
"@runfusion/fusion": patch
---

summary: A card stuck mid-merge can be retried again on boards with renamed columns.
category: fix
dev: `recoverStaleMergingStatus` read the literal `in-review`, so a stale `merging`/`merging-pr` stamp was never cleared on a renamed board. That stamp gates both the merger and the dashboard's manual Retry, so the card could neither progress nor be retried by hand. Read resolves via `resolveProjectColumnsForRoles`, per-card check resolves per card.
