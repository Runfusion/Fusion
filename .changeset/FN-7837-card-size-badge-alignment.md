---
"@runfusion/fusion": patch
---

summary: Task card size badge (S/M/L) no longer drops onto a misaligned second row on cards with extra badges.
category: fix
dev: Groups the wrapping header status/meta badges in TaskCard so `.card-id` and the right-aligned `.card-header-actions` (holding `.card-size-badge`) stay on the top row; fixes the fast-mode (`.card-execution-mode-badge`) orphaned-size-chip case (FN-7832 repro).
