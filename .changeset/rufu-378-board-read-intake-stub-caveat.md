---
"@runfusion/fusion": patch
---

summary: Board list and search tools now say a row shows a truncated intake stub, not the card's plan.
category: fix
dev: `fn_task_list` / `fn_task_search` descriptions append the shared `TASK_BOARD_READ_CAVEAT` from `@fusion/core` and say the row carries a `label` instead of a `description`; the pi registration keeps the sentence as an inline literal so `node scripts/sync-fusion-skill-tools.mjs` regenerates the tracked skill catalog with it.
