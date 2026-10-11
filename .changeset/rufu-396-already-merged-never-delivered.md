---
"@runfusion/fusion": patch
---

summary: Stop parking cards as "already merged" just because the base branch mentions their id.
category: fix
dev: Self-healing re-verifies ownership of base commits stamped for the card and cross-checks their touched paths against the card's declared File Scope; a proven never-delivered card is reclaimed through the stale-metadata path instead of consuming the branch-conflict retry budget. New audit event `task:already-merged-never-delivered`.
