---
"@runfusion/fusion": patch
---

summary: A crash-leftover `merging` status is now cleared at startup even on cards outside the review lanes.
category: fix
dev: `clearStaleMergingStatuses` used to read the review-role lanes only, so a card that reached `done` still marked merge-active stayed that way forever (observed: 33 days, four restarts) — and the same leftover inside a review lane would have blocked its manual merge permanently. The clear now scans every live lane with a `derive: false` + `excludeLog: true` read.
