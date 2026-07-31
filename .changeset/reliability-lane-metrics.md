---
"@runfusion/fusion": patch
---

summary: The Reliability health panel no longer reports a perfect review-failure rate on a renamed board.
category: fix
dev: `/api/health/reliability` counted review entries and bounces with two `getTaskMovedCountsByDay` queries naming `in-review` and `in-progress`. On a renamed board both returned `{}`, so every per-day count was zero and `inReviewFailureRate7d` divided one zero by another and reported healthy. The lanes are now resolved via `resolveProjectColumnsForRoles` and the query is issued per (from, to) pair and summed.
